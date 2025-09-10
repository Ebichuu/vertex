const { TaskQueue } = require('../redis');
const logger = require('../logger');

class ClientTaskQueue extends TaskQueue {
  constructor() {
    super('client_maindata', {
      maxConcurrent: 8, // 最多同时8个客户端请求
      maxRetries: 2,
      retryDelay: 3000
    });
  }

  async executeTask(task) {
    const { clientId, action, params } = task.data;
    
    try {
      const client = global.runningClient[clientId];
      if (!client) {
        logger.warn(`客户端 ${clientId} 不存在，跳过任务`);
        return;
      }

      logger.debug(`开始执行客户端任务: ${client.alias}, 动作: ${action}`);
      const startTime = Date.now();

      let result;
      switch (action) {
        case 'getMaindata':
          result = await this.executeGetMaindata(client);
          break;
        case 'autoDelete':
          result = await this.executeAutoDelete(client, params);
          break;
        case 'trackerSync':
          result = await this.executeTrackerSync(client);
          break;
        case 'autoReannounce':
          result = await this.executeAutoReannounce(client);
          break;
        case 'record':
          result = await this.executeRecord(client);
          break;
        case 'flashFitTime':
          result = await this.executeFlashFitTime(client, params);
          break;
        default:
          throw new Error(`未知的客户端动作: ${action}`);
      }

      const duration = Date.now() - startTime;
      logger.debug(`客户端任务完成: ${client.alias}, 动作: ${action}, 耗时: ${duration}ms`);
      
      return result;
    } catch (error) {
      logger.error(`客户端任务执行失败: ${clientId}, 动作: ${task.data.action}`, error);
      
      // 重试逻辑
      if (task.retries < this.maxRetries) {
        await this.retryTask(task);
      }
      
      throw error;
    }
  }

  async executeGetMaindata(client) {
    try {
      const res = await client.client.getMaindata(client.clientUrl, client.cookie);
      
      if (typeof res === 'string') {
        client.cookie.sessionId = res;
        return await client.client.getMaindata(client.clientUrl, client.cookie);
      }
      
      // 处理maindata响应
      if (res.torrents) {
        const oldMaindata = client.maindata;
        client.maindata = res;
        client.status = true;
        client.errorCount = 0;
        
        // 计算平均速度
        if (res.torrents && res.torrents.length > 0) {
          const uploadSpeeds = res.torrents.map(torrent => torrent.uploadSpeed || 0);
          const downloadSpeeds = res.torrents.map(torrent => torrent.downloadSpeed || 0);
          
          client.avgUploadSpeed = uploadSpeeds.reduce((sum, speed) => sum + speed, 0);
          client.avgDownloadSpeed = downloadSpeeds.reduce((sum, speed) => sum + speed, 0);
        }
        
        // 处理种子状态变化
        if (oldMaindata && oldMaindata.torrents) {
          this.handleTorrentStatusChanges(client, oldMaindata.torrents, res.torrents);
        }
      } else {
        logger.warn(`客户端 ${client.alias} 返回的数据格式异常`);
      }
      
      return res;
    } catch (error) {
      client.errorCount++;
      client.status = false;
      logger.error(`客户端 ${client.alias} 获取数据失败:`, error);
      throw error;
    }
  }

  async executeAutoDelete(client, params) {
    if (!client.autoDelete) {
      return;
    }
    
    logger.debug(`执行自动删种: ${client.alias}`);
    return await client.autoDelete();
  }

  async executeTrackerSync(client) {
    if (client.client.type !== 'qBittorrent') {
      return;
    }
    
    logger.debug(`执行Tracker同步: ${client.alias}`);
    return await client.trackerSync();
  }

  async executeAutoReannounce(client) {
    if (client.client.type !== 'qBittorrent' || !client.autoReannounce) {
      return;
    }
    
    logger.debug(`执行自动重新汇报: ${client.alias}`);
    return await client.autoReannounce();
  }

  async executeRecord(client) {
    logger.debug(`执行记录任务: ${client.alias}`);
    return await client.record();
  }

  async executeFlashFitTime(client, params) {
    if (!params || !params.rule) {
      logger.warn(`FlashFitTime任务缺少规则参数: ${client.alias}`);
      return;
    }
    
    logger.debug(`执行适配时间刷新: ${client.alias}, 规则: ${params.rule.alias}`);
    return await client.flashFitTime(params.rule);
  }

  // 处理种子状态变化
  handleTorrentStatusChanges(client, oldTorrents, newTorrents) {
    try {
      // 创建新旧种子的映射
      const oldTorrentMap = new Map();
      oldTorrents.forEach(torrent => {
        oldTorrentMap.set(torrent.hash, torrent);
      });

      // 检查状态变化
      newTorrents.forEach(newTorrent => {
        const oldTorrent = oldTorrentMap.get(newTorrent.hash);
        if (oldTorrent && oldTorrent.state !== newTorrent.state) {
          logger.debug(`种子状态变化: ${newTorrent.name}, ${oldTorrent.state} -> ${newTorrent.state}`);
          
          // 可以在这里添加状态变化的处理逻辑
          // 比如通知、统计等
        }
      });
    } catch (error) {
      logger.error(`处理种子状态变化时出错: ${client.alias}`, error);
    }
  }
}

module.exports = ClientTaskQueue;
