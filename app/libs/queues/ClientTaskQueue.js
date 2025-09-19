const { TaskQueue } = require('../redis');
const logger = require('../logger');

class ClientTaskQueue extends TaskQueue {
  constructor() {
    super('client_maindata', {
      maxConcurrent: 10 // 最多同时10个客户端请求，移除重试配置
    });
    
    // 客户端故障管理
    this.failedClients = new Map(); // clientId -> { count, lastFailTime, blocked }
    this.blockDuration = 2 * 60 * 1000; // 阻塞2分钟（快速响应，因为客户端查询频繁）
    this.maxFailuresBeforeBlock = 5; // 5次连续失败后阻塞（更快识别故障）
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

  // 记录客户端失败（优化版：任何错误都计数）
  recordClientFailure(clientId, error) {
    const now = Date.now();
    const clientInfo = this.failedClients.get(clientId) || { count: 0, lastFailTime: 0, blocked: false };
    
    // 任何类型的错误都计数（不再区分连接错误）
    clientInfo.count++;
    clientInfo.lastFailTime = now;
    
    // 达到阈值则阻塞并清理积压任务
    if (clientInfo.count >= this.maxFailuresBeforeBlock) {
      clientInfo.blocked = true;
      // 异步清理积压任务（不阻塞当前执行）
      this.clearClientQueue(clientId).then(clearedTasks => {
        // 保存清理任务数量用于监控
        clientInfo.clearedTasks = clearedTasks;
        this.failedClients.set(clientId, clientInfo);
        logger.error(`客户端 ${clientId} 连续失败 ${clientInfo.count} 次，已阻塞 ${this.blockDuration/1000} 秒，清理积压任务 ${clearedTasks} 个`);
      }).catch(error => {
        logger.error(`清理客户端 ${clientId} 积压任务失败:`, error);
      });
    }
    
    this.failedClients.set(clientId, clientInfo);
  }

  // 记录客户端成功
  recordClientSuccess(clientId) {
    // 清除失败记录
    this.failedClients.delete(clientId);
  }

  // 清理指定客户端的所有积压任务
  async clearClientQueue(clientId) {
    let clearedCount = 0;
    
    try {
      // 清理高优先级队列
      const highPriorityTasks = await this.removeTasksFromQueue(`${this.queueName}:high`, clientId);
      clearedCount += highPriorityTasks;
      
      // 清理普通优先级队列
      const normalPriorityTasks = await this.removeTasksFromQueue(`${this.queueName}:normal`, clientId);
      clearedCount += normalPriorityTasks;
      
      logger.error(`已清理客户端 ${clientId} 的积压任务: 高优先级 ${highPriorityTasks} 个, 普通优先级 ${normalPriorityTasks} 个`);
    } catch (error) {
      logger.error(`清理客户端 ${clientId} 队列时出错:`, error);
    }
    
    return clearedCount;
  }

  // 从指定队列中移除特定客户端的任务
  async removeTasksFromQueue(queueKey, clientId) {
    const redis = require('../redis');
    let removedCount = 0;
    
    try {
      // 获取队列中的所有任务
      const tasks = await redis.lrange(queueKey, 0, -1);
      if (!tasks || tasks.length === 0) return 0;
      
      // 逐个检查并移除匹配的任务
      for (const taskStr of tasks) {
        try {
          const task = JSON.parse(taskStr);
          if (task.data && task.data.clientId === clientId) {
            // 移除这个任务
            await redis.lrem(queueKey, 1, taskStr);
            removedCount++;
          }
        } catch (parseError) {
          // 跳过无法解析的任务
          continue;
        }
      }
    } catch (error) {
      logger.error(`从队列 ${queueKey} 移除任务时出错:`, error);
    }
    
    return removedCount;
  }

  // 判断是否为连接错误（保留用于日志分析）
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
      logger.error(`客户端 ${clientId} 被阻塞，跳过任务入队: ${taskData.action}`);
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
          remainingTime: Math.ceil(remaining / 1000),
          clearedTasks: info.clearedTasks || 0
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
        logger.warn(`客户端 ${clientId} 被阻塞，跳过任务执行: ${action}`);
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
      // 先检查是否已阻塞
      if (this.isClientBlocked(clientId)) {
        logger.error(`客户端 ${clientId} 已被阻塞，任务已丢弃: ${task.data.action}`);
        return;
      }
      
      // 记录失败
      this.recordClientFailure(clientId, error);
      
      logger.error(`客户端任务执行失败: ${clientId}, 动作: ${task.data.action}`, error);
      
      // 再次检查阻塞状态（可能在recordClientFailure中触发阻塞）
      if (this.isClientBlocked(clientId)) {
        logger.error(`客户端 ${clientId} 因连续失败已被阻塞，任务已丢弃: ${task.data.action}`);
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
      logger.error(`客户端任务失败已处理: ${clientId}, 继续处理下一个任务`);
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
