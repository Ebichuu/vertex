const { TaskQueue } = require('../redis');
const logger = require('../logger');

class RssTaskQueue extends TaskQueue {
  constructor() {
    super('rss_fetch', {
      maxConcurrent: 5 // 最多同时5个RSS请求，移除重试配置
    });
    
    // RSS源故障管理
    this.failedRssSources = new Map(); // rssId -> { count, lastFailTime, blocked }
    this.blockDuration = 10 * 60 * 1000; // RSS源阻塞10分钟（比客户端长，给更多恢复时间）
    this.maxFailuresBeforeBlock = 5; // 5次连续失败后阻塞（更谨慎，避免因偶发流控阻塞）
  }

  // 检查RSS源是否被阻塞
  isRssBlocked(rssId) {
    const rssInfo = this.failedRssSources.get(rssId);
    if (!rssInfo || !rssInfo.blocked) {
      return false;
    }
    
    // 检查阻塞是否过期
    if (Date.now() - rssInfo.lastFailTime > this.blockDuration) {
      // 重置RSS源状态
      this.failedRssSources.delete(rssId);
      logger.info(`RSS源 ${rssId} 阻塞已解除，重新开始处理任务`);
      return false;
    }
    
    return true;
  }

  // 记录RSS源失败
  recordRssFailure(rssId, error) {
    const now = Date.now();
    const rssInfo = this.failedRssSources.get(rssId) || { count: 0, lastFailTime: 0, blocked: false };
    
    // 如果是网络错误，计数增加
    if (this.isNetworkError(error)) {
      rssInfo.count++;
      rssInfo.lastFailTime = now;
      
      // 达到阈值则阻塞
      if (rssInfo.count >= this.maxFailuresBeforeBlock) {
        rssInfo.blocked = true;
        logger.warn(`RSS源 ${rssId} 连续失败 ${rssInfo.count} 次，阻塞 ${this.blockDuration/1000} 秒`);
      }
    } else {
      // 其他类型错误，重置计数
      rssInfo.count = 0;
    }
    
    this.failedRssSources.set(rssId, rssInfo);
  }

  // 记录RSS源成功
  recordRssSuccess(rssId) {
    // 清除失败记录
    this.failedRssSources.delete(rssId);
  }

  // 判断是否为网络错误
  isNetworkError(error) {
    if (!error) return false;
    const networkErrors = ['ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'];
    return networkErrors.includes(error.code) || 
           (error.message && networkErrors.some(code => error.message.includes(code))) ||
           (error.message && error.message.includes('getaddrinfo')) || // DNS解析失败
           (error.message && error.message.includes('timeout')); // 各类超时错误
  }

  // 重写enqueue方法，添加阻塞检查
  async enqueue(taskData, priority = 'normal') {
    const { rssId } = taskData;
    
    // 检查RSS源是否被阻塞
    if (rssId && this.isRssBlocked(rssId)) {
      logger.debug(`RSS源 ${rssId} 被阻塞，跳过任务入队`);
      return;
    }
    
    return super.enqueue(taskData, priority);
  }

  // 获取阻塞状态信息
  getBlockedRssStatus() {
    const blocked = [];
    for (const [rssId, info] of this.failedRssSources.entries()) {
      if (info.blocked) {
        const remaining = Math.max(0, this.blockDuration - (Date.now() - info.lastFailTime));
        blocked.push({
          rssId,
          failures: info.count,
          remainingTime: Math.ceil(remaining / 1000)
        });
      }
    }
    return blocked;
  }

  async executeTask(task) {
    const { rssId, action, params } = task.data;
    
    try {
      // 再次检查阻塞状态
      if (this.isRssBlocked(rssId)) {
        logger.debug(`RSS源 ${rssId} 被阻塞，跳过任务执行`);
        return;
      }
      
      const rssInstance = global.runningRss[rssId];
      if (!rssInstance) {
        logger.warn(`RSS实例 ${rssId} 不存在，跳过任务`);
        return;
      }

      logger.debug(`开始执行RSS任务: ${rssInstance.alias}, 动作: ${action}`);
      const startTime = Date.now();

      let result;
      switch (action) {
        case 'fetchRss':
          result = await this.executeFetchRss(rssInstance, params);
          break;
        case 'clearCount':
          result = await this.executeClearCount(rssInstance);
          break;
        default:
          throw new Error(`未知的RSS动作: ${action}`);
      }

      const duration = Date.now() - startTime;
      logger.debug(`RSS任务完成: ${rssInstance.alias}, 耗时: ${duration}ms`);
      
      // 记录成功
      this.recordRssSuccess(rssId);
      
      return result;
    } catch (error) {
      // 记录失败
      this.recordRssFailure(rssId, error);
      
      logger.error(`RSS任务执行失败: ${rssId}`, error);
      
      // 对于被阻塞的RSS源，直接丢弃任务
      if (this.isRssBlocked(rssId)) {
        logger.debug(`RSS源 ${rssId} 已被阻塞，任务已丢弃`);
        return;
      }
      
      // 无重试，直接丢弃失败任务
      this.logTaskFailure(task, error);
      
      // 不再重新抛出错误，让任务队列继续处理下一个任务
      logger.debug(`RSS任务失败已处理: ${rssId}, 继续处理下一个任务`);
    }
  }

  async executeFetchRss(rssInstance, params) {
    // 检查是否已在运行
    if (rssInstance.isRunning) {
      logger.debug(`RSS ${rssInstance.alias} 已在运行中，跳过本次执行`);
      return null;
    }

    rssInstance.isRunning = true;
    
    try {
      // 直接调用原始的rss方法，利用其内置的去重逻辑
      await rssInstance.rss(params?.torrents);
    } finally {
      rssInstance.isRunning = false;
    }
  }

  async executeClearCount(rssInstance) {
    rssInstance.addCount = 0;
    logger.debug(`RSS ${rssInstance.alias} 计数已清零`);
  }
}

module.exports = RssTaskQueue;