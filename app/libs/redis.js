const redis = require('redis');

const config = require('./config');
const logger = require('./logger');
const util = require('util');

const client = redis.createClient(config.getRedisConfig());

client.on('error', (err) => {
  logger.error(err);
});

client.on('connect', () => {
  logger.info('Redis connected!');
});

exports.set = util.promisify(client.set).bind(client);
exports.get = util.promisify(client.get).bind(client);
exports.del = util.promisify(client.del).bind(client);
exports.expire = util.promisify(client.expire).bind(client);
exports.scan = util.promisify(client.scan).bind(client);
exports.setnx = util.promisify(client.setnx).bind(client);
exports.keys = util.promisify(client.keys).bind(client);
exports.setWithExpire = async function (k, v, ex) {
  if (!ex && +ex !== ex) {
    throw 'illegal expire';
  }
  await exports.set(k, v);
  await exports.expire(k, ex);
};
exports.deleteAll = async function (str, cursor = '0') {
  const res = await exports.scan(cursor, 'MATCH', str, 'COUNT', '10');
  if (+res[0] === 0 && res[1].length === 0) {
    return logger.info('Redis Delete All', str);
  } else {
    for (const key of res[1]) {
      await exports.del(key);
      logger.debug('redis delete', key);
    }
    return await exports.deleteAll(str, res[0]);
  }
};

// 新增：队列相关方法
exports.lpush = util.promisify(client.lpush).bind(client);
exports.rpop = util.promisify(client.rpop).bind(client);
exports.brpop = util.promisify(client.brpop).bind(client);
exports.llen = util.promisify(client.llen).bind(client);
exports.publish = util.promisify(client.publish).bind(client);

// 队列工具类
class TaskQueue {
  constructor(queueName, options = {}) {
    this.queueName = queueName;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 5000;
    this.maxConcurrent = options.maxConcurrent || 5;
    this.activeWorkers = 0;
    this.isProcessing = false;
  }

  // 生成任务ID
  _generateTaskId() {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  }

  // 添加任务到队列
  async enqueue(taskData, priority = 'normal') {
    const task = {
      id: this._generateTaskId(),
      data: taskData,
      priority,
      timestamp: Date.now(),
      retries: 0
    };

    const queueKey = priority === 'high' 
      ? `vertex:queue:${this.queueName}:high`
      : `vertex:queue:${this.queueName}:normal`;

    await exports.lpush(queueKey, JSON.stringify(task));
    logger.debug(`任务已入队: ${this.queueName}, ID: ${task.id}`);
    
    // 触发处理
    this.processQueue();
    return task.id;
  }

  // 处理队列
  async processQueue() {
    if (this.isProcessing || this.activeWorkers >= this.maxConcurrent) {
      return;
    }

    this.isProcessing = true;
    
    try {
      while (this.activeWorkers < this.maxConcurrent) {
        // 优先处理高优先级队列
        let taskJson = await exports.rpop(`vertex:queue:${this.queueName}:high`);
        
        if (!taskJson) {
          // 处理普通优先级队列
          taskJson = await exports.rpop(`vertex:queue:${this.queueName}:normal`);
        }

        if (!taskJson) {
          break; // 队列为空
        }

        const task = JSON.parse(taskJson);
        this.activeWorkers++;
        
        // 异步处理任务
        this.executeTask(task).finally(() => {
          this.activeWorkers--;
          // 继续处理队列
          setTimeout(() => this.processQueue(), 100);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // 执行具体任务（子类需要实现）
  async executeTask(task) {
    throw new Error('executeTask method must be implemented by subclass');
  }

  // 获取队列状态
  async getQueueStatus() {
    const highCount = await exports.llen(`vertex:queue:${this.queueName}:high`) || 0;
    const normalCount = await exports.llen(`vertex:queue:${this.queueName}:normal`) || 0;
    
    return {
      queueName: this.queueName,
      highPriority: highCount,
      normalPriority: normalCount,
      total: highCount + normalCount,
      activeWorkers: this.activeWorkers,
      maxConcurrent: this.maxConcurrent
    };
  }

  // 重试任务
  async retryTask(task) {
    if (task.retries < this.maxRetries) {
      task.retries++;
      setTimeout(() => {
        this.enqueue(task.data, task.priority === 'high' ? 'high' : 'normal');
      }, this.retryDelay);
      logger.info(`任务重试: ${task.id}, 第${task.retries}次重试`);
      return true;
    }
    return false;
  }
}

exports.TaskQueue = TaskQueue;