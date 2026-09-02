const assert = require('assert');
const PeerObserver = require('../app/libs/PeerObserver');

const silentLogger = {
  info () {},
  warn () {},
  error () {}
};

const run = async () => {
  let clock = 1_000_000;
  const peerWrites = [];
  let finished;
  const store = {
    async startSession () { return 7; },
    async upsertPeers (sessionId, peers) {
      assert.strictEqual(sessionId, 7);
      peerWrites.push(...peers);
    },
    async finishSession (sessionId, summary) {
      assert.strictEqual(sessionId, 7);
      finished = summary;
    }
  };

  const rawSeederKey = '198.51.100.20:51413';
  const rawLeecherKey = '203.0.113.8:6881';
  const responses = [
    {
      rid: 11,
      full_update: true,
      peers: {
        [rawSeederKey]: { progress: 1, client: 'qBittorrent/5.2.2', dl_speed: 0, up_speed: 40_000_000, downloaded: 0, uploaded: 80_000_000 },
        [rawLeecherKey]: { progress: 0.4, client: 'qBittorrent/5.1.0', dl_speed: 10_000_000, up_speed: 100_000, downloaded: 30_000_000, uploaded: 1_000_000 }
      }
    },
    {
      rid: 12,
      peers_removed: [rawSeederKey],
      peers: {
        [rawLeecherKey]: { progress: 0.8, client: 'qBittorrent/5.1.0', dl_speed: 12_000_000, up_speed: 200_000, downloaded: 60_000_000, uploaded: 2_000_000 }
      }
    }
  ];
  const ridCalls = [];
  const localTorrent = { hash: 'a'.repeat(40), progress: 0.5, size: 100, completed: 50 };
  const client = {
    id: 'qb-a',
    _client: { type: 'qBittorrent' },
    maindata: { torrents: [localTorrent] },
    async getTorrentPeers (hash, rid) {
      assert.strictEqual(hash, 'a'.repeat(40));
      ridCalls.push(rid);
      if (ridCalls.length === 2) {
        localTorrent.progress = 1;
        localTorrent.completed = 100;
      }
      return responses.shift();
    }
  };
  const observer = new PeerObserver({
    logger: silentLogger,
    store,
    secret: 'test-secret',
    now: () => clock,
    sleep: async delay => { clock += delay; },
    fastIntervalMs: 1000,
    slowIntervalMs: 5000,
    fastWindowMs: 5000,
    maxDurationMs: 10_000,
    postCompletionMs: 0
  });

  await observer._run({
    client,
    torrentHash: 'a'.repeat(40),
    metadata: { torrentName: 'test torrent' }
  });

  assert.deepStrictEqual(ridCalls, [0, 11]);
  assert.strictEqual(finished.status, 'completed');
  assert.strictEqual(finished.pollCount, 2);
  assert.strictEqual(finished.peerCount, 2);
  assert.strictEqual(finished.completePeerCount, 1);
  assert.strictEqual(finished.initialCompletePeerCount, 1);

  const seeder = peerWrites.filter(peer => peer.completeOnFirstSeen).pop();
  assert.ok(seeder);
  assert.strictEqual(seeder.peerKey.length, 24);
  assert.strictEqual(seeder.peerIp, '198.51.100.20');
  assert.strictEqual(seeder.peerPort, 51413);
  assert.strictEqual(seeder.removedAt, 1001);
  assert.strictEqual(observer._fingerprint(rawSeederKey), observer._fingerprint(rawSeederKey));

  const ipv6State = observer._makePeerState('[2001:db8::20]:6881', {}, 1002);
  assert.strictEqual(ipv6State.peerIp, '2001:db8::20');
  assert.strictEqual(ipv6State.peerPort, 6881);

  const invalidObserver = new PeerObserver({ logger: silentLogger, store });
  assert.strictEqual(invalidObserver.observe(client, 'fakehash'), false);
  assert.strictEqual(invalidObserver.observe({ _client: { type: 'Transmission' } }, 'a'.repeat(40)), false);
};

run()
  .then(() => console.log('peer observer tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
