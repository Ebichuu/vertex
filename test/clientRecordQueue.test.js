const assert = require('assert');

const redisPath = require.resolve('../app/libs/redis');
const loggerPath = require.resolve('../app/libs/logger');
const queuePath = require.resolve('../app/libs/queues/ClientTaskQueue');

class FakeTaskQueue {
  constructor (name) {
    this.name = name;
    this.tasks = [];
  }

  async enqueue (taskData, priority, options) {
    this.tasks.push({ data: taskData, priority, options });
    return String(this.tasks.length);
  }

  async getQueueStatus () {
    return { highPriority: 0, normalPriority: this.tasks.length, total: this.tasks.length, activeWorkers: 0, maxConcurrent: 1 };
  }
}

require.cache[redisPath] = {
  id: redisPath,
  filename: redisPath,
  loaded: true,
  exports: {
    TaskQueue: FakeTaskQueue,
    lrange: async () => [],
    lrem: async () => 0,
    del: async () => 0
  }
};
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { debug () {}, info () {}, warn () {}, error () {} }
};
delete require.cache[queuePath];

const ClientTaskQueue = require(queuePath);

const testBusyRecordIsDeferred = async function () {
  const queue = new ClientTaskQueue();
  queue.busyRetryDelayMs = 5;
  const sampleTime = 1234567800;
  let recordCalls = 0;
  global.runningClient = {
    client: {
      alias: 'client',
      record: async () => { recordCalls++; }
    }
  };
  queue.activeClientTasks.set('client', { action: 'trackerSync', startTime: Date.now() });

  await queue.executeTask({
    data: { clientId: 'client', action: 'record', params: { sampleTime } },
    priority: 'normal'
  });
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.strictEqual(recordCalls, 0);
  assert.strictEqual(queue.slowQueue.tasks.length, 1);
  assert.strictEqual(queue.slowQueue.tasks[0].data.params.sampleTime, sampleTime);
};

const testRecordKeepsScheduledTime = async function () {
  const queue = new ClientTaskQueue();
  queue.actionTimeoutMs.record = 20;
  const sampleTime = 1234567800;
  let recordedAt;
  global.runningClient = {
    client: {
      alias: 'client',
      record: async value => { recordedAt = value; }
    }
  };

  await queue.executeTask({
    data: { clientId: 'client', action: 'record', params: { sampleTime } },
    priority: 'normal'
  });

  assert.strictEqual(recordedAt, sampleTime);
  assert.ok(queue._getDedupeConfig({ clientId: 'client', action: 'record', params: { sampleTime } }).dedupeKey.endsWith(`:${sampleTime}`));
};

Promise.all([
  testBusyRecordIsDeferred(),
  testRecordKeepsScheduledTime()
])
  .then(() => console.log('client record queue tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
