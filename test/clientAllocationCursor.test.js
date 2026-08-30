const assert = require('assert');

const ClientAllocationCursor = require('../app/libs/ClientAllocationCursor');

const silentLogger = {
  info () {},
  error () {}
};

const testPersistentRotation = async function () {
  const values = new Map();
  const store = {
    get: async key => values.get(key),
    set: async (key, value) => values.set(key, value)
  };
  const clients = [{ id: 'lim' }, { id: 'ean' }];

  const assignments = [];
  for (let i = 0; i < 6; i++) {
    const restartedTask = new ClientAllocationCursor({ rssId: 'official', store, logger: silentLogger, alias: 'official' });
    await restartedTask.load();
    assignments.push(restartedTask.select(clients).id);
    await restartedTask.persist();
  }

  assert.deepStrictEqual(assignments, ['lim', 'ean', 'lim', 'ean', 'lim', 'ean']);
};

const testUnavailableClientIsSkipped = async function () {
  const store = {
    get: async () => 'lim',
    set: async () => {}
  };
  const clients = [{ id: 'lim', online: false }, { id: 'ean', online: true }];
  const cursor = new ClientAllocationCursor({ rssId: 'official', store, logger: silentLogger, alias: 'official' });
  await cursor.load();
  assert.strictEqual(cursor.select(clients, client => client.online).id, 'ean');

  clients[0].online = true;
  assert.strictEqual(cursor.select(clients, client => client.online).id, 'lim');
};

Promise.all([
  testPersistentRotation(),
  testUnavailableClientIsSkipped()
])
  .then(() => console.log('client allocation cursor tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
