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
exports.lrange = util.promisify(client.lrange).bind(client);
exports.lrem = util.promisify(client.lrem).bind(client);
exports.publish = util.promisify(client.publish).bind(client);
exports.expire = util.promisify(client.expire).bind(client);
exports.eval = util.promisify(client.eval).bind(client);

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
  async _acquireDedupe(dedupeKey, dedupeTtlSeconds) {
    if (!dedupeKey) return true;
    const acquired = await exports.setnx(dedupeKey, 1);
    if (acquired !== 1) {
      return false;
    }
    if (dedupeTtlSeconds) {
      await exports.expire(dedupeKey, dedupeTtlSeconds);
    }
    return true;
  }

  async _releaseDedupe(dedupeKey) {
    if (!dedupeKey) return;
    try {
      await exports.del(dedupeKey);
    } catch (error) {
      logger.debug(`释放队列去重标记失败: ${dedupeKey}`, error);
    }
  }

  async enqueue(taskData, priority = 'normal', options = {}) {
    const dedupeKey = options.dedupeKey;
    const dedupeTtlSeconds = options.dedupeTtlSeconds;
    if (dedupeKey) {
      const acquired = await this._acquireDedupe(dedupeKey, dedupeTtlSeconds);
      if (!acquired) {
        logger.debug(`任务去重生效，跳过入队: ${this.queueName}, key=${dedupeKey}`);
        return;
      }
    }

    const task = {
      id: this._generateTaskId(),
      data: taskData,
      priority,
      timestamp: Date.now(),
      retries: 0,
      dedupeKey
    };

    const queueKey = priority === 'high' 
      ? `vertex:queue:${this.queueName}:high`
      : `vertex:queue:${this.queueName}:normal`;

    try {
      await exports.lpush(queueKey, JSON.stringify(task));
      logger.debug(`任务已入队: ${this.queueName}, ID: ${task.id}`);
    } catch (error) {
      if (dedupeKey) {
        await this._releaseDedupe(dedupeKey);
      }
      throw error;
    }
    
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
        this.executeTask(task).catch(error => {
          // 记录最后的错误信息，用于死信队列
          task.lastError = error.message || error.toString();
        }).finally(() => {
          if (task.dedupeKey) {
            this._releaseDedupe(task.dedupeKey);
          }
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

  // 记录任务失败（简单记录，不存储）
  logTaskFailure(task, error) {
    logger.warn(`任务失败已丢弃: ${task.id}, 队列: ${this.queueName}, 错误: ${error.message || error.toString()}`);
  }
}

exports.TaskQueue = TaskQueue;
