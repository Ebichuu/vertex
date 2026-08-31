const assert = require('assert');
const bencode = require('bencode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TorrentBatchBuffer = require('../app/libs/queues/TorrentBatchBuffer');
const WebMonitorCursor = require('../app/libs/webMonitorCursor');
const loggerPath = require.resolve('../app/libs/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { debug () {}, info () {}, warn () {}, error () {} }
};
const utilPath = require.resolve('../app/libs/util');
const util = { requestPromise: async () => { throw new Error('unexpected request'); } };
require.cache[utilPath] = {
  id: utilPath,
  filename: utilPath,
  loaded: true,
  exports: util
};
const webMonitor = require('../app/libs/webMonitor');
const webMonitorParser = require('../app/libs/webMonitorParser');

const pageUrls = webMonitorParser.buildChdPageUrls('https://ptchdbits.co/torrents.php', 2);
assert.strictEqual(pageUrls.length, 2);
assert.strictEqual(new URL(pageUrls[0]).searchParams.get('sort'), '4');
assert.strictEqual(new URL(pageUrls[0]).searchParams.get('type'), 'desc');
assert.strictEqual(new URL(pageUrls[0]).searchParams.get('page'), null);
assert.strictEqual(new URL(pageUrls[1]).searchParams.get('page'), '1');

const html = `
  <table class="torrents"><tbody><tr>
    <td>Animation</td>
    <td>
      <a href="details.php?id=575778&amp;hit=1"><b>Recommendations from Iwamoto Senpai</b></a>
      <a href="download.php?id=575778">download</a>
    </td>
    <td></td><td></td><td>1.50 GiB</td>
    <td class="rowfollow nowrap"><span title="2026-08-30 02:07:16">6 min</span></td>
  </tr></tbody></table>`;
const parsed = webMonitorParser.parseChd(html, pageUrls[0], 'session=test');
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].sourceKey, 'ptchdbits.co:575778');
assert.strictEqual(parsed[0].sourceType, 'web');
assert.strictEqual(parsed[0].size, 1.5 * 1024 ** 3);
assert.ok(parsed[0].pubTime > 0);

const cursor = new WebMonitorCursor({ startedAt: 1000, initialLookbackSeconds: 120 });
const firstSelection = cursor.selectNew([
  { sourceKey: 'chd:old', pubTime: 100 },
  { sourceKey: 'chd:recent', pubTime: 950 }
], { now: 1000, maxAgeSeconds: 600 });
assert.deepStrictEqual(firstSelection.map(item => item.sourceKey), ['chd:recent']);
assert.deepStrictEqual(cursor.selectNew([{ sourceKey: 'chd:old', pubTime: 100 }]), []);
assert.deepStrictEqual(
  cursor.selectNew([{ sourceKey: 'chd:new', pubTime: 1100 }], { now: 1100, maxAgeSeconds: 600 }).map(item => item.sourceKey),
  ['chd:new']
);
assert.deepStrictEqual(
  cursor.selectNew([{ sourceKey: 'chd:late', pubTime: 1000 }], { now: 1701, maxAgeSeconds: 600 }),
  []
);
assert.strictEqual(cursor.lastSkippedCount, 1);

const testMetadataEnrichment = async function () {
  const metadata = {
    announce: Buffer.from('https://tracker.invalid/announce'),
    info: {
      length: 1024,
      name: Buffer.from('The Fast and the Furious 2001 2160p x265 10bit-CHD'),
      'piece length': 16384,
      pieces: Buffer.alloc(20)
    }
  };
  const buffer = bencode.encode(metadata);
  const expectedHash = crypto.createHash('sha1').update(bencode.encode(metadata.info)).digest('hex');
  const torrentDir = path.join(__dirname, '../torrents');
  const torrentDirExisted = fs.existsSync(torrentDir);
  if (!torrentDirExisted) fs.mkdirSync(torrentDir, { recursive: true });
  const filepath = path.join(torrentDir, expectedHash + '.torrent');
  const originalRequestPromise = util.requestPromise;
  let requestCount = 0;
  util.requestPromise = async () => {
    requestCount += 1;
    return { statusCode: 200, body: buffer };
  };
  try {
    const result = await webMonitor.enrichTorrents([parsed[0]], { parserType: 'chd', cookie: 'session=test' });
    assert.strictEqual(requestCount, 1);
    assert.strictEqual(result[0].hash, expectedHash);
    assert.strictEqual(result[0].name, 'The Fast and the Furious 2001 2160p x265 10bit-CHD');
    assert.strictEqual(result[0].size, 1024);
    assert.strictEqual(result[0].sourceKey, parsed[0].sourceKey);
    assert.ok(fs.existsSync(filepath));
  } finally {
    util.requestPromise = originalRequestPromise;
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    if (!torrentDirExisted && fs.existsSync(torrentDir)) fs.rmdirSync(torrentDir);
  }
};
cursor.forget([{ sourceKey: 'chd:new' }]);
assert.deepStrictEqual(
  cursor.selectNew([{ sourceKey: 'chd:new', pubTime: 1701 }], { now: 1701, maxAgeSeconds: 600 }).map(item => item.sourceKey),
  ['chd:new']
);
assert.deepStrictEqual(
  cursor.selectNew([{ sourceKey: 'chd:after-sleep', pubTime: 1701 }], { now: 1701, maxAgeSeconds: 600, skipAll: true }),
  []
);
assert.strictEqual(cursor.lastSkippedCount, 1);

const buffer = new TorrentBatchBuffer();
const webTorrent = { sourceKey: 'ptchdbits.co:575778', sourceType: 'web', name: 'web' };
const rssTorrent = { sourceKey: 'ptchdbits.co:575778', sourceType: 'rss', name: 'rss' };
buffer.merge('official', [webTorrent]);
buffer.merge('official', [rssTorrent, { sourceKey: 'ptchdbits.co:575779', name: 'next' }]);
assert.strictEqual(buffer.size('official'), 2);
const drained = buffer.drain('official');
assert.strictEqual(drained.length, 2);
assert.strictEqual(drained[0], webTorrent);
assert.strictEqual(buffer.size('official'), 0);

const testQueueMerging = async function () {
  const redisPath = require.resolve('../app/libs/redis');
  const queuePath = require.resolve('../app/libs/queues/RssTaskQueue');

  class FakeTaskQueue {
    constructor () {
      this.tasks = [];
    }

    async enqueue (taskData, priority) {
      this.tasks.push({ data: taskData, priority });
      return String(this.tasks.length);
    }

    logTaskFailure () {}
  }

  require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { TaskQueue: FakeTaskQueue }
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { debug () {}, info () {}, warn () {}, error () {} }
  };
  delete require.cache[queuePath];
  const RssTaskQueue = require(queuePath);
  const queue = new RssTaskQueue();
  queue.actionTimeoutMs.fetchRss = 50;
  const processed = [];
  global.runningRss = {
    official: {
      alias: 'official',
      isRunning: false,
      rss: async (torrents) => processed.push(torrents)
    }
  };

  await queue.enqueue({ rssId: 'official', action: 'fetchRss', params: { torrents: [webTorrent] } });
  await queue.enqueue({ rssId: 'official', action: 'fetchRss', params: { torrents: [rssTorrent, { sourceKey: 'ptchdbits.co:575779' }] } });
  assert.strictEqual(queue.tasks.length, 1);
  await queue.executeTask(queue.tasks.shift());
  assert.deepStrictEqual(processed[0].map(item => item.sourceKey), ['ptchdbits.co:575778', 'ptchdbits.co:575779']);

  let finishRunning;
  global.runningRss.official.rss = async (torrents) => {
    processed.push(torrents);
    await new Promise(resolve => { finishRunning = resolve; });
  };
  await queue.enqueue({ rssId: 'official', action: 'fetchRss', params: { torrents: [{ sourceKey: 'ptchdbits.co:575780' }] } });
  const runningTask = queue.executeTask(queue.tasks.shift());
  await queue.enqueue({ rssId: 'official', action: 'fetchRss', params: { torrents: [{ sourceKey: 'ptchdbits.co:575781' }] } });
  assert.strictEqual(queue.tasks.length, 0);
  finishRunning();
  await runningTask;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.strictEqual(queue.tasks.length, 1);
  global.runningRss.official.rss = async (torrents) => processed.push(torrents);
  await queue.executeTask(queue.tasks.shift());
  assert.deepStrictEqual(processed[2].map(item => item.sourceKey), ['ptchdbits.co:575781']);
};

testMetadataEnrichment()
  .then(testQueueMerging)
  .then(() => console.log('web monitor tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
