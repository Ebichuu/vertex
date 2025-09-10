const { TaskQueue } = require('../redis');
const logger = require('../logger');

class RssTaskQueue extends TaskQueue {
  constructor() {
    super('rss_fetch', {
      maxConcurrent: 5, // 最多同时5个RSS请求
      maxRetries: 2,
      retryDelay: 10000
    });
  }

  async executeTask(task) {
    const { rssId, action, params } = task.data;
    
    try {
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
      
      return result;
    } catch (error) {
      logger.error(`RSS任务执行失败: ${rssId}`, error);
      
      // 重试逻辑由基类TaskQueue处理
      if (!await this.retryTask(task)) {
        logger.error(`RSS任务达到最大重试次数，已发送到死信队列: ${rssId}, 动作: ${action}`);
      }
      
      throw error;
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