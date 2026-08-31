const assert = require('assert');

const ClientAllocationCursor = require('../app/libs/ClientAllocationCursor');
const ClientLoadBalancer = require('../app/libs/ClientLoadBalancer');

const silentLogger = {
  info () {},
  error () {}
};
const store = {
  get: async () => undefined,
  set: async () => {}
};

const makeClient = (id, uploadSpeed, seedingCount, leechingCount, freeSpaceOnDisk, avgUploadSpeed = 0) => ({
  id,
  uploadBandwidth: 1024 * 1024 * 1024,
  avgUploadSpeed,
  maindata: { uploadSpeed, seedingCount, leechingCount, freeSpaceOnDisk }
});

const cursor = new ClientAllocationCursor({ rssId: 'official', store, logger: silentLogger, alias: 'official' });

const busyClient = makeClient('lim', 800 * 1024 * 1024, 100, 12, 100 * 1024 ** 3);
const idleClient = makeClient('ean', 20 * 1024 * 1024, 20, 2, 200 * 1024 ** 3);
const busyVsIdle = new ClientLoadBalancer([busyClient, idleClient], cursor);
assert.strictEqual(busyVsIdle.select(10 * 1024 ** 3).id, 'ean');

const equalCursor = new ClientAllocationCursor({ rssId: 'equal', store, logger: silentLogger, alias: 'equal' });
const equalClients = [
  makeClient('lim', 0, 10, 0, 200 * 1024 ** 3),
  makeClient('ean', 0, 10, 0, 200 * 1024 ** 3)
];
const equalLoad = new ClientLoadBalancer(equalClients, equalCursor);
assert.deepStrictEqual(
  [equalLoad.select(1024).id, equalLoad.select(1024).id],
  ['lim', 'ean']
);

const spaceCursor = new ClientAllocationCursor({ rssId: 'space', store, logger: silentLogger, alias: 'space' });
const spaceLimited = new ClientLoadBalancer([
  makeClient('lim', 0, 0, 0, 5 * 1024 ** 3),
  makeClient('ean', 0, 0, 0, 20 * 1024 ** 3)
], spaceCursor);
assert.strictEqual(spaceLimited.select(10 * 1024 ** 3).id, 'ean');

const absolutePressureCursor = new ClientAllocationCursor({ rssId: 'absolute', store, logger: silentLogger, alias: 'absolute' });
const absolutePressure = new ClientLoadBalancer([
  makeClient('crowded', 0.2 * 1024 ** 2, 5, 57, 82 * 1024 ** 3),
  makeClient('available', 5 * 1024 ** 2, 4, 1, 112 * 1024 ** 3)
], absolutePressureCursor);
assert.strictEqual(absolutePressure.select(3 * 1024 ** 3).id, 'available');

const emaCursor = new ClientAllocationCursor({ rssId: 'ema', store, logger: silentLogger, alias: 'ema' });
const emaPressure = new ClientLoadBalancer([
  makeClient('recently-busy', 0, 10, 0, 200 * 1024 ** 3, 800 * 1024 ** 2),
  makeClient('steady', 100 * 1024 ** 2, 10, 0, 200 * 1024 ** 3, 100 * 1024 ** 2)
], emaCursor);
assert.strictEqual(emaPressure.select(1024).id, 'steady');

const cappedCursor = new ClientAllocationCursor({ rssId: 'capped', store, logger: silentLogger, alias: 'capped' });
const cappedPressure = new ClientLoadBalancer([
  makeClient('over-capacity', 2 * 1024 ** 3, 0, 0, 200 * 1024 ** 3),
  makeClient('idle', 0, 0, 0, 200 * 1024 ** 3)
], cappedCursor);
const cappedDetails = cappedPressure.getScoreDetails();
assert.strictEqual(cappedDetails.find(row => row.client.id === 'over-capacity').uploadPressure, 1);

console.log('client load balancer tests passed');
