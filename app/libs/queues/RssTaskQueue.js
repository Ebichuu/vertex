const { TaskQueue } = require('../redis');
const rss = require('../rss');
const logger = require('../logger');
const moment = require('moment');

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
      logger.debug(`RSS任务完成: ${rssInstance.alias}, 动作: ${action}, 耗时: ${duration}ms`);
      
      return result;
    } catch (error) {
      logger.error(`RSS任务执行失败: ${rssId}, 动作: ${task.data.action}`, error);
      
      // 重试逻辑
      if (task.retries < this.maxRetries) {
        await this.retryTask(task);
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
      // 执行RSS获取逻辑
      await this.performRssFetch(rssInstance, params?.torrents);
    } finally {
      rssInstance.isRunning = false;
    }
  }

  async performRssFetch(rssInstance, _torrents) {
    const startTime = moment();
    
    try {
      // 获取种子列表
      const torrents = _torrents || (await Promise.all(rssInstance.urls.map(url => rss.getTorrents(url)))).flat();
      
      if (!torrents || torrents.length === 0) {
        logger.debug(rssInstance.alias, 'RSS获取到0个种子');
        rssInstance.lastRssTime = moment().unix();
        return;
      }

      logger.debug(rssInstance.alias, `RSS获取到 ${torrents.length} 个种子`);

      // 种子去重和过滤
      const uniqueTorrents = this.deduplicateTorrents(torrents);
      const filteredTorrents = await this.filterTorrents(rssInstance, uniqueTorrents);

      if (filteredTorrents.length === 0) {
        logger.debug(rssInstance.alias, '过滤后无有效种子');
        rssInstance.lastRssTime = moment().unix();
        return;
      }

      // 检查每小时推送上限
      if (rssInstance.addCount + filteredTorrents.length > rssInstance.addCountPerHour) {
        const allowedCount = rssInstance.addCountPerHour - rssInstance.addCount;
        if (allowedCount > 0) {
          const acceptableTorrents = filteredTorrents.slice(0, allowedCount);
          await this.processTorrents(rssInstance, acceptableTorrents);
          
          // 拒绝剩余的种子
          const rejectedTorrents = filteredTorrents.slice(allowedCount);
          await this.rejectTorrents(rssInstance, rejectedTorrents, 
            `拒绝原因: 达到单小时推送上限: ${rssInstance.addCount} / ${rssInstance.addCountPerHour}`);
        } else {
          // 全部拒绝
          await this.rejectTorrents(rssInstance, filteredTorrents,
            `拒绝原因: 达到单小时推送上限: ${rssInstance.addCount} / ${rssInstance.addCountPerHour}`);
        }
      } else {
        // 检查最长休眠时间
        if (moment().unix() - rssInstance.lastRssTime > +rssInstance.maxSleepTime) {
          await this.rejectTorrents(rssInstance, filteredTorrents, '拒绝原因: 最长休眠时间');
        } else {
          // 正常处理种子
          await this.processTorrents(rssInstance, filteredTorrents);
        }
      }

      // 更新最后RSS时间
      rssInstance.lastRssTime = moment().unix();
      
      const duration = moment().diff(startTime, 'seconds');
      logger.debug(rssInstance.alias, `RSS任务完成，总耗时: ${duration}秒`);

    } catch (error) {
      logger.error(rssInstance.alias, 'RSS执行失败:', error);
      // 即使失败也更新时间，避免触发休眠保护
      rssInstance.lastRssTime = moment().unix();
      throw error;
    }
  }

  // 种子去重
  deduplicateTorrents(torrents) {
    const seen = new Set();
    return torrents.filter(torrent => {
      const key = `${torrent.hash}-${torrent.size}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  // 过滤种子
  async filterTorrents(rssInstance, torrents) {
    const filteredTorrents = [];
    
    for (const torrent of torrents) {
      try {
        // 应用接受规则
        let accepted = false;
        if (rssInstance.acceptRules.length > 0) {
          for (const rule of rssInstance.acceptRules) {
            if (rssInstance._fitRule(rule, torrent)) {
              accepted = true;
              break;
            }
          }
        } else {
          accepted = true; // 没有接受规则时默认接受
        }

        if (!accepted) {
          continue;
        }

        // 应用拒绝规则
        let rejected = false;
        for (const rule of rssInstance.rejectRules) {
          if (rssInstance._fitRule(rule, torrent)) {
            rejected = true;
            break;
          }
        }

        if (rejected) {
          continue;
        }

        // 检查是否跳过相同种子
        if (rssInstance.skipSameTorrent) {
          const exists = await this.checkTorrentExists(rssInstance, torrent);
          if (exists) {
            continue;
          }
        }

        filteredTorrents.push(torrent);
      } catch (error) {
        logger.error(rssInstance.alias, `过滤种子时出错: ${torrent.name}`, error);
      }
    }

    return filteredTorrents;
  }

  // 检查种子是否已存在
  async checkTorrentExists(rssInstance, torrent) {
    // 这里可以实现检查逻辑，比如查询数据库或缓存
    // 简化版本，实际实现可能更复杂
    try {
      for (const clientId of rssInstance.clientArr) {
        const client = global.runningClient[clientId];
        if (client && client.maindata && client.maindata.torrents) {
          const exists = client.maindata.torrents.some(t => 
            t.hash === torrent.hash || t.size === torrent.size
          );
          if (exists) {
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      logger.error(rssInstance.alias, '检查种子存在性时出错:', error);
      return false;
    }
  }

  // 处理种子
  async processTorrents(rssInstance, torrents) {
    for (const torrent of torrents) {
      try {
        // 这里调用原有的种子处理逻辑
        // 简化版本，实际实现需要根据原有逻辑来适配
        await this.processSingleTorrent(rssInstance, torrent);
        rssInstance.addCount++;
      } catch (error) {
        logger.error(rssInstance.alias, `处理种子失败: ${torrent.name}`, error);
      }
    }
  }

  // 处理单个种子
  async processSingleTorrent(rssInstance, torrent) {
    // 这里需要实现实际的种子处理逻辑
    // 包括下载种子文件、添加到下载器等
    logger.debug(rssInstance.alias, `处理种子: ${torrent.name}`);
    
    // 记录到数据库
    const util = require('../util');
    await util.runRecord(
      'INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
      [torrent.hash, torrent.name, torrent.size, rssInstance.id, torrent.link, moment().unix(), 1, '成功添加']
    );
  }

  // 拒绝种子
  async rejectTorrents(rssInstance, torrents, reason) {
    const util = require('../util');
    
    for (const torrent of torrents) {
      try {
        await util.runRecord(
          'INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, rssInstance.id, torrent.link, moment().unix(), 2, reason]
        );

        // 发送拒绝通知
        if (rssInstance.ntf) {
          await rssInstance.ntf.rejectTorrent(rssInstance._rss, undefined, torrent, reason);
        }
      } catch (error) {
        logger.error(rssInstance.alias, `拒绝种子记录失败: ${torrent.name}`, error);
      }
    }
  }

  async executeClearCount(rssInstance) {
    rssInstance.addCount = 0;
    logger.debug(`RSS ${rssInstance.alias} 计数已清零`);
  }
}

module.exports = RssTaskQueue;
