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

const makeClient = (id, uploadSpeed, seedingCount, leechingCount, freeSpaceOnDisk) => ({
  id,
  uploadBandwidth: 1024 * 1024 * 1024,
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

console.log('client load balancer tests passed');
