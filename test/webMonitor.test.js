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

const momentUnix = value => Math.floor(new Date(`${value.replace(' ', 'T')}+08:00`).getTime() / 1000);

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
      <span class="tag-official">官方</span><span class="tag-subtitle">中字</span>
    </td>
    <td></td><td></td><td>1.50 GiB</td>
    <td class="rowfollow nowrap"><span title="2026-08-30 02:07:16">6 min</span></td>
  </tr></tbody></table>`;
const parsed = webMonitorParser.parseChd(html, pageUrls[0], 'session=test');
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].sourceKey, 'ptchdbits.co:575778');
assert.strictEqual(parsed[0].sourceType, 'web');
assert.strictEqual(parsed[0].size, 1.5 * 1024 ** 3);
assert.strictEqual(parsed[0].siteOfficial, 1);
assert.strictEqual(parsed[0].siteRevived, 0);
assert.strictEqual(parsed[0].siteRepost, 0);
assert.strictEqual(parsed[0].chdCategory, '官种');
assert.deepStrictEqual(parsed[0].chdLabels, ['官种']);
assert.ok(parsed[0].pubTime > 0);
assert.strictEqual(webMonitorParser.isChdOfficialTitle('Example.Release.2160p-CHD'), true);
assert.strictEqual(webMonitorParser.isChdOfficialTitle('Example.Release.2160p-Other'), false);

const rssOfficial = webMonitorParser.applyChdClassification({ name: 'Example.Release.2160p-CHD' });
assert.strictEqual(rssOfficial.chdCategory, '官种');
assert.deepStrictEqual(rssOfficial.chdLabels, ['官种']);
const rssRepost = webMonitorParser.applyChdClassification({ name: 'Example.Release.2160p-Other' });
assert.strictEqual(rssRepost.chdCategory, '转载');
assert.strictEqual(rssRepost.siteRepost, 1);

const parsedWithoutOfficialTag = webMonitorParser.parseChd(html.replace('<span class="tag-official">官方</span>', ''), pageUrls[0], 'session=test');
assert.strictEqual(parsedWithoutOfficialTag[0].siteOfficial, 0);
assert.strictEqual(parsedWithoutOfficialTag[0].siteRepost, 1);
assert.strictEqual(parsedWithoutOfficialTag[0].chdCategory, '转载');
assert.deepStrictEqual(parsedWithoutOfficialTag[0].chdLabels, ['转载']);

const revivalPageUrl = 'https://ptchdbits.co/renewtorrents.php';
assert.deepStrictEqual(webMonitorParser.buildChdPageUrls(revivalPageUrl, 2), [revivalPageUrl]);
const revivalHtml = `
  <table class="torrents"><tbody>
  <tr>
    <td>Movie</td>
    <td>
      <a href="details.php?id=453132&amp;hit=1"><b>Revived non-official torrent</b></a>
      <a href="download.php?id=453132">download</a>
      <span class="free"><span title="2026-09-13 01:32:00">free</span></span>
    </td>
    <td></td><td></td><td>10.00 GiB</td>
    <td class="rowfollow nowrap"><span title="2025-06-09 10:00:00">old</span></td>
  </tr>
  <tr>
    <td>Movie</td>
    <td>
      <a href="details.php?id=527346&amp;hit=1"><b>Revived official torrent</b></a>
      <a href="download.php?id=527346">download</a>
      <span class="tag-official">官方</span>
      <span class="free"><span title="2026-09-13 02:00:00">free</span></span>
    </td>
    <td></td><td></td><td>20.00 GiB</td>
    <td class="rowfollow nowrap"><span title="2024-01-01 08:00:00">old</span></td>
  </tr>
  </tbody></table>`;
const revived = webMonitorParser.parseChd(revivalHtml, revivalPageUrl, 'session=test');
assert.strictEqual(revived.length, 2);
assert.strictEqual(revived[0].siteOfficial, 0);
assert.strictEqual(revived[0].siteRevived, 1);
assert.strictEqual(revived[0].siteRepost, 0);
assert.strictEqual(revived[0].chdCategory, '复活区');
assert.deepStrictEqual(revived[0].chdLabels, ['复活区']);
assert.strictEqual(revived[0].pubTime, momentUnix('2026-09-06 01:32:00'));
assert.strictEqual(revived[0].originalPubTime, momentUnix('2025-06-09 10:00:00'));
assert.ok(revived[0].sourceKey.endsWith(`:revived:${revived[0].revivalTime}`));
assert.strictEqual(revived[1].siteOfficial, 1);
assert.strictEqual(revived[1].siteRevived, 1);
assert.strictEqual(revived[1].siteRepost, 0);
assert.strictEqual(revived[1].chdCategory, '复活区');
assert.deepStrictEqual(revived[1].chdLabels, ['官种', '复活区']);

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
    assert.strictEqual(result[0].siteOfficial, 1);
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
