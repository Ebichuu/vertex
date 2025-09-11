const { TaskQueue } = require('../redis');
const logger = require('../logger');

class ClientTaskQueue extends TaskQueue {
  constructor() {
    super('client_maindata', {
      maxConcurrent: 8 // 最多同时8个客户端请求，移除重试配置
    });
    
    // 客户端故障管理
    this.failedClients = new Map(); // clientId -> { count, lastFailTime, blocked }
    this.blockDuration = 1 * 60 * 1000; // 阻塞1分钟（快速响应，因为客户端查询频繁）
    this.maxFailuresBeforeBlock = 3; // 3次连续失败后阻塞（更快识别故障）
  }

  // 检查客户端是否被阻塞
  isClientBlocked(clientId) {
    const clientInfo = this.failedClients.get(clientId);
    if (!clientInfo || !clientInfo.blocked) {
      return false;
    }
    
    // 检查阻塞是否过期
    if (Date.now() - clientInfo.lastFailTime > this.blockDuration) {
      // 重置客户端状态
      this.failedClients.delete(clientId);
      logger.info(`客户端 ${clientId} 阻塞已解除，重新开始处理任务`);
      return false;
    }
    
    return true;
  }

  // 记录客户端失败
  recordClientFailure(clientId, error) {
    const now = Date.now();
    const clientInfo = this.failedClients.get(clientId) || { count: 0, lastFailTime: 0, blocked: false };
    
    // 如果是连接错误，计数增加
    if (this.isConnectionError(error)) {
      clientInfo.count++;
      clientInfo.lastFailTime = now;
      
      // 达到阈值则阻塞
      if (clientInfo.count >= this.maxFailuresBeforeBlock) {
        clientInfo.blocked = true;
        logger.warn(`客户端 ${clientId} 连续失败 ${clientInfo.count} 次，阻塞 ${this.blockDuration/1000} 秒`);
      }
    } else {
      // 其他类型错误，重置计数
      clientInfo.count = 0;
    }
    
    this.failedClients.set(clientId, clientInfo);
  }

  // 记录客户端成功
  recordClientSuccess(clientId) {
    // 清除失败记录
    this.failedClients.delete(clientId);
  }

  // 判断是否为连接错误
  isConnectionError(error) {
    if (!error) return false;
    const connectionErrors = ['ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'];
    return connectionErrors.includes(error.code) || 
           (error.message && connectionErrors.some(code => error.message.includes(code)));
  }

  // 重写enqueue方法，添加阻塞检查
  async enqueue(taskData, priority = 'normal') {
    const { clientId } = taskData;
    
    // 检查客户端是否被阻塞
    if (clientId && this.isClientBlocked(clientId)) {
      logger.debug(`客户端 ${clientId} 被阻塞，跳过任务入队`);
      return;
    }
    
    return super.enqueue(taskData, priority);
  }

  // 获取阻塞状态信息
  getBlockedClientsStatus() {
    const blocked = [];
    for (const [clientId, info] of this.failedClients.entries()) {
      if (info.blocked) {
        const remaining = Math.max(0, this.blockDuration - (Date.now() - info.lastFailTime));
        blocked.push({
          clientId,
          failures: info.count,
          remainingTime: Math.ceil(remaining / 1000)
        });
      }
    }
    return blocked;
  }

  async executeTask(task) {
    const { clientId, action, params } = task.data;
    
    try {
      // 再次检查阻塞状态
      if (this.isClientBlocked(clientId)) {
        logger.debug(`客户端 ${clientId} 被阻塞，跳过任务执行`);
        return;
      }
      
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
      
      // 记录成功
      this.recordClientSuccess(clientId);
      
      return result;
    } catch (error) {
      // 记录失败
      this.recordClientFailure(clientId, error);
      
      logger.error(`客户端任务执行失败: ${clientId}, 动作: ${task.data.action}`, error);
      
      // 对于被阻塞的客户端，直接丢弃任务
      if (this.isClientBlocked(clientId)) {
        logger.debug(`客户端 ${clientId} 已被阻塞，任务已丢弃`);
        return;
      }
      
      // 无重试，直接丢弃失败任务
      this.logTaskFailure(task, error);
      
      // 标记客户端状态
      const client = global.runningClient[clientId];
      if (client) {
        client.errorCount++;
        client.status = false;
      }
      
      // 不再重新抛出错误，让任务队列继续处理下一个任务
      logger.debug(`客户端任务失败已处理: ${clientId}, 继续处理下一个任务`);
    }
  }

  async executeGetMaindata(client) {
    try {
      const res = await client.client.getMaindata(client.clientUrl, client.cookie);
      
      if (typeof res === 'string') {
        if (res === 'Unauthorized') {
          // 需要重新登录
          await client.login();
          return;
        } else {
          // 更新session ID并重试
          client.cookie.sessionId = res;
          return await client.client.getMaindata(client.clientUrl, client.cookie);
        }
      }
      
      // 完整处理maindata响应（使用原始逻辑）
      if (res.torrents) {
        const statusLeeching = ['downloading', 'stalledDL', 'Downloading'];
        const statusSeeding = ['uploading', 'stalledUP', 'Seeding'];
        
        client.maindata = res;
        // Add client ID and alias
        client.maindata.clientId = client.id;
        client.maindata.clientAlias = client.alias;
        client.maindata.leechingCount = 0;
        client.maindata.seedingCount = 0;
        client.maindata.usedSpace = 0;
        
        client.maindata.torrents.forEach((item) => {
          item.trackerStatus = client.trackerStatus[item.hash] || '';
          client.maindata.usedSpace += item.completed;
          if (statusLeeching.indexOf(item.state) !== -1) {
            client.maindata.leechingCount += 1;
          } else if (statusSeeding.indexOf(item.state) !== -1) {
            client.maindata.seedingCount += 1;
          }
        });
        
        client.avgDownloadSpeed = res.downloadSpeed * 0.1 + (client.avgDownloadSpeed || 0) * 0.9;
        client.avgUploadSpeed = res.uploadSpeed * 0.1 + (client.avgUploadSpeed || 0) * 0.9;
        
        client.status = true;
        client.errorCount = 0;
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
