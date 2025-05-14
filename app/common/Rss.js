const rss = require('../libs/rss');
const util = require('../libs/util');
const logger = require('../libs/logger');
const redis = require('../libs/redis');
const cron = require('node-cron');
const bencode = require('bencode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Push = require('./Push');
const redlock = require('../libs/redlock');

class Rss {
  constructor (rss) {
    this._rss = rss;
    this.id = rss.id;
    this.maxSleepTime = rss.maxSleepTime;
    this.lastRssTime = 0;
    this.alias = rss.alias;
    this.urls = rss.rssUrls;
    this.clientArr = rss.clientArr || [rss.client];
    this.clientSortBy = rss.clientSortBy;
    this.autoReseed = rss.autoReseed;
    this.onlyReseed = rss.onlyReseed;
    this.reseedClients = rss.reseedClients;
    this.pushMessage = rss.pushMessage;
    this.skipSameTorrent = rss.skipSameTorrent;
    this.scrapeFree = rss.scrapeFree;
    this.scrapeHr = rss.scrapeHr;
    this.sleepTime = rss.sleepTime;
    this.cookie = rss.cookie;
    this.savePath = rss.savePath;
    this.category = rss.category;
    this.paused = rss.paused;
    this.autoTMM = rss.autoTMM;
    this.useCustomRegex = rss.useCustomRegex;
    this.regexStr = rss.regexStr;
    this.replaceStr = rss.replaceStr;
    this.addCountPerHour = +rss.addCountPerHour || 20;
    this.addCount = 0;
    this.pushTorrentFile = rss.pushTorrentFile;
    this.notify = util.listPush().filter(item => item.id === rss.notify)[0] || {};
    this.notify.push = rss.pushNotify;
    this.notify.dryrun = rss.dryrun;
    this.ntf = new Push(this.notify);
    this._acceptRules = rss.acceptRules || [];
    this._rejectRules = rss.rejectRules || [];
    this.acceptRules = util.listRssRule().filter(item => (this._acceptRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.rejectRules = util.listRssRule().filter(item => (this._rejectRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.downloadLimit = util.calSize(rss.downloadLimit, rss.downloadLimitUnit);
    this.uploadLimit = util.calSize(rss.uploadLimit, rss.uploadLimitUnit);
    this.maxClientUploadSpeed = util.calSize(rss.maxClientUploadSpeed, rss.maxClientUploadSpeedUnit);
    this.maxClientDownloadSpeed = util.calSize(rss.maxClientDownloadSpeed, rss.maxClientDownloadSpeedUnit);
    this.maxClientDownloadCount = +rss.maxClientDownloadCount;
    this.isRunning = false;
    if (!rss.dryrun) {
      this.rssJob = cron.schedule(rss.cron, async () => { 
        try { 
          if (this.isRunning) {
            logger.warn(this.alias, 'RSS任务已在运行中，跳过本次执行');
            return;
          }
          
          this.isRunning = true;
          
          const globalLockKey = `vertex:rss:global:${this.id}`;
          let lock = null;
          
          try {
            lock = await redlock.lock(globalLockKey, 600000);
            logger.debug(this.alias, '获取RSS任务全局锁成功');
            
            await this.rss(); 
          } catch (err) {
            if (err.name === 'LockError') {
              logger.warn(this.alias, 'RSS任务已被其他进程锁定，跳过本次执行');
            } else {
              logger.error(this.alias, '执行RSS任务出错:', err);
            }
          } finally {
            if (lock) {
              try {
                await lock.unlock();
                logger.debug(this.alias, '释放RSS任务全局锁成功');
              } catch (unlockErr) {
                logger.error(this.alias, '释放RSS任务全局锁失败:', unlockErr);
              }
            }
            
            this.isRunning = false;
          }
        } catch (e) { 
          this.isRunning = false;
          logger.error(this.alias, '启动RSS任务失败:', e); 
        } 
      });
      this.clearCount = cron.schedule('0 * * * *', () => { this.addCount = 0; });
      
      this.cleanLockJob = cron.schedule('0 */6 * * *', async () => {
        try {
          await this.cleanExpiredLocks();
        } catch (e) {
          logger.error(this.alias, '清理过期锁任务失败:', e);
        }
      });
      
      logger.info('Rss 任务', this.alias, '初始化完毕');
    }
  }

  _all (str, keys) {
    if (!keys || keys.length === 0) return true;
    for (const key of keys) {
      if (str.indexOf(key) === -1) return false;
    }
    return true;
  };

  _sum (arr) {
    let sum = 0;
    for (const item of arr) {
      sum += item;
    }
    return sum;
  }

  _getSum (a, b) {
    return a + b;
  };

  async _downloadTorrent (url, _hash) {
    if (_hash && fs.existsSync(path.join(__dirname, '../../torrents', _hash + '.torrent'))) {
      return { hash: _hash, filepath: path.join(__dirname, '../../torrents', _hash + '.torrent') };
    }
    const res = await util.requestPromise({
      url: url,
      method: 'GET',
      encoding: null,
      headers: {
        cookie: this.cookie
      }
    });
    const buffer = Buffer.from(res.body, 'utf-8');
    const torrent = bencode.decode(buffer);
    const size = torrent.info.length || torrent.info.files.map(i => i.length).reduce(this._getSum, 0);
    const fsHash = crypto.createHash('sha1');
    fsHash.update(bencode.encode(torrent.info));
    const md5 = fsHash.digest('md5');
    let hash = '';
    for (const v of md5) {
      hash += v < 16 ? '0' + v.toString(16) : v.toString(16);
    };
    const filepath = path.join(__dirname, '../../torrents', hash + '.torrent');
    fs.writeFileSync(filepath, buffer);
    return {
      filepath,
      hash,
      size,
      name: torrent.info.name.toString()
    };
  };

  _fitConditions (_torrent, conditions) {
    let fit = true;
    const torrent = { ..._torrent };
    torrent.description = torrent.description || '';
    for (const condition of conditions) {
      let value;
      switch (condition.compareType) {
      case 'equals':
        fit = fit && (torrent[condition.key] === condition.value || torrent[condition.key] === +condition.value);
        break;
      case 'bigger':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] > value;
        break;
      case 'smaller':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] < value;
        break;
      case 'contain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length !== 0;
        break;
      case 'includeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) !== -1;
        break;
      case 'notContain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length === 0;
        break;
      case 'notIncludeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) === -1;
        break;
      case 'regExp':
        fit = fit && (torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      case 'notRegExp':
        fit = fit && !(torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      }
    }
    return fit;
  }

  _fitRule (_rule, _torrent) {
    const rule = { ..._rule };
    const torrent = { ..._torrent };
    if (rule.type === 'javascript') {
      try {
        // eslint-disable-next-line no-eval
        return (eval(rule.code))(torrent);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '存在语法错误\n', e);
        return false;
      }
    } else {
      try {
        return rule.conditions.length !== 0 && this._fitConditions(torrent, rule.conditions);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '遇到错误\n', e);
        return false;
      }
    }
  }

  destroy () {
    logger.info('销毁 Rss 实例:', this.alias);
    this.rssJob.stop();
    delete this.rssJob;
    this.clearCount.stop();
    delete this.clearCount;
    
    // 停止清理锁任务
    if (this.cleanLockJob) {
      this.cleanLockJob.stop();
      delete this.cleanLockJob;
    }
    
    // 如果正在运行，尝试释放相关锁
    if (this.isRunning) {
      const globalLockKey = `vertex:rss:global:${this.id}`;
      redis.del(globalLockKey).catch(err => logger.error('清除全局锁失败:', err));
      this.isRunning = false;
    }
    
    delete global.runningRss[this.id];
  }

  // 清理过期锁方法
  async cleanExpiredLocks() {
    try {
      // 使用redlock时，锁会自动过期，不需要手动清理
      // 但我们可以检查Redis中是否有遗留的锁资源
      
      // 获取所有与此RSS相关的锁键
      const torrentLockKeys = await redis.keys(`vertex:torrent:lock:*`);
      const globalLockKey = `vertex:rss:global:${this.id}`;
      
      if (torrentLockKeys && torrentLockKeys.length > 0) {
        logger.info(this.alias, `发现 ${torrentLockKeys.length} 个潜在的种子锁记录`);
        
        // redlock使用的锁格式是特殊的，通常以{锁名称}:*格式存在
        // 我们需要小心处理，避免错误地删除有效锁
        
        // 这里我们不直接删除锁，而是记录可能的问题
        for (const key of torrentLockKeys) {
          const resourceValues = await redis.keys(`${key}:*`);
          if (resourceValues && resourceValues.length > 0) {
            logger.warn(this.alias, `发现可能的遗留锁资源: ${key}, 拥有 ${resourceValues.length} 个资源记录`);
          }
        }
      }
      
      // 检查全局RSS锁资源
      const globalLockResources = await redis.keys(`${globalLockKey}:*`);
      if (globalLockResources && globalLockResources.length > 0) {
        logger.warn(this.alias, `发现可能的全局锁遗留资源，拥有 ${globalLockResources.length} 个资源记录`);
      }
    } catch (err) {
      logger.error(this.alias, '检查锁资源失败:', err);
    }
  }

  /**
   * 将种子信息缓存到Redis中，用于跳过相同种子检查
   * @param {string} clientId - 下载器ID
   * @param {object} torrent - 种子信息对象，需包含hash和size
   * @param {number} expireTime - 缓存过期时间（秒），默认10分钟
   */
  async cacheTorrentToClient(clientId, torrent, expireTime = 600) {
    try {
      // 基础参数检查
      if (!clientId || !torrent || !torrent.hash || !torrent.size) {
        logger.warn(this.alias, `缓存种子参数不完整: clientId=${clientId}, torrent=${JSON.stringify(torrent || {})}`);
        return;
      }

      // 缓存种子hash
      const hashKey = `vertex:client_torrent:${clientId}:hash:${torrent.hash}`;
      await redis.setWithExpire(hashKey, '1', expireTime);
      
      // 缓存种子大小
      const sizeKey = `vertex:client_torrent:${clientId}:size:${torrent.size}`;
      await redis.setWithExpire(sizeKey, torrent.hash, expireTime);
      
      logger.debug(this.alias, `缓存种子到客户端 ${clientId}, Hash: ${torrent.hash}, Size: ${util.formatSize(torrent.size)}, 名称: ${torrent.name?.substring(0, 30)}..., 过期时间: ${expireTime}秒`);
    } catch (err) {
      logger.error(this.alias, `缓存种子到Redis失败: ${err.message}`);
    }
  }
  
  /**
   * 检查客户端是否已存在相同的种子（通过hash或size）
   * @param {string} clientId - 下载器ID
   * @param {object} torrent - 种子信息对象，需包含hash和size
   * @return {object|null} - 如果存在返回{exists: true, reason: '原因'}, 否则返回null
   */
  async checkTorrentExistsInClient(clientId, torrent) {
    try {
      // 基础参数检查
      if (!clientId || !torrent || !torrent.hash || !torrent.size) {
        logger.warn(this.alias, `检查客户端种子存在性参数不完整: clientId=${clientId}, torrent=${JSON.stringify(torrent || {})}`);
        return null;
      }

      // 检查hash是否存在
      const hashKey = `vertex:client_torrent:${clientId}:hash:${torrent.hash}`;
      const hashExists = await redis.get(hashKey);
      
      if (hashExists) {
        return {
          exists: true,
          reason: '拒绝原因: 种子已添加过'
        };
      }
      
      // 检查size是否存在
      const sizeKey = `vertex:client_torrent:${clientId}:size:${torrent.size}`;
      const sizeExists = await redis.get(sizeKey);
      
      if (sizeExists) {
        return {
          exists: true,
          reason: '拒绝原因: 下载器中已存在同大小种子',
          existingHash: sizeExists
        };
      }
      
      return null;
    } catch (err) {
      logger.error(this.alias, `检查客户端种子存在性失败: ${err.message}`);
      return null; // 出错时返回null，允许继续处理
    }
  }

  reloadRssRule () {
    logger.info('重新载入 Rss 规则', this.alias);
    this.acceptRules = util.listRssRule().filter(item => (this._acceptRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.rejectRules = util.listRssRule().filter(item => (this._rejectRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
  }

  reloadPush () {
    logger.info('Rss', this.alias, '重新载入推送方式');
    this.notify = util.listPush().filter(item => item.id === this._rss.notify)[0] || {};
    this.notify.push = this._rss.pushNotify;
    this.ntf = new Push(this.notify);
  }

  async _pushTorrent (torrent, _client) {
    if (this.autoReseed && torrent.hash.indexOf('fakehash') === -1) {
      for (const key of this.reseedClients) {
        const client = global.runningClient[key];
        if (!client) {
          logger.error('Rss', this.alias, '下载器', key, '不存在');
          continue;
        }
        for (const _torrent of client.maindata.torrents) {
          if (+_torrent.size === +torrent.size && +_torrent.completed === +_torrent.size) {
            const bencodeInfo = await rss.getTorrentNameByBencode(torrent.url);
            if (_torrent.name === bencodeInfo.name && _torrent.hash !== bencodeInfo.hash) {
              try {
                this.addCount += 1;
                await client.addTorrent(torrent.url, torrent.hash, true, this.uploadLimit, this.downloadLimit, _torrent.savePath, this.category);
                await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, category, link, record_time, add_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  [torrent.hash, torrent.name, torrent.size, this.id, this.category, torrent.link, moment().unix(), moment().unix(), 1, '辅种']);
                await this.ntf.addTorrent(this._rss, client, torrent);
                return;
              } catch (error) {
                logger.error(this.alias, '下载器', client, '添加种子', torrent.name, '失败\n', error);
                await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, category, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  [torrent.hash, torrent.name, torrent.size, this.id, this.category, torrent.link, moment().unix(), 3, '辅种失败']);
                await this.ntf.addTorrentError(this._rss, client, torrent);
              }
            }
          }
        }
      }
    }
    if (!this.onlyReseed) {
      let speed;
      if (_client.sameServerClients) {
        speed = {
          uploadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.uploadSpeed || 0)),
          downloadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.downloadSpeed || 0))
        };
      } else {
        speed = {
          uploadSpeed: _client.avgUploadSpeed,
          downloadSpeed: _client.avgDownloadSpeed
        };
      }
      if (_client.maxUploadSpeed && speed.uploadSpeed > _client.maxUploadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`);
        return;
      }
      if (_client.maxDownloadSpeed && speed.downloadSpeed > _client.maxDownloadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`);
        return;
      }
      const leechNum = _client.maindata.leechingCount;
      if (_client.maxLeechNum && leechNum >= _client.maxLeechNum) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`);
        return;
      }
      if (_client.minFreeSpace && _client.maindata.freeSpaceOnDisk <= _client.minFreeSpace) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`);
        return;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (fitRules.length === 0 && this.acceptRules.length !== 0) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 不符合所有规则']);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 不符合所有规则');
        return;
      }
      if (this.scrapeFree) {
        try {
          if (!await util.scrapeFree(torrent.link, this.cookie)) {
            const isScraped = await redis.get(`vertex:scrape:free:${torrent.hash}`);
            if (this.sleepTime && (moment().unix() - +this.sleepTime) < torrent.pubTime && !isScraped) {
              logger.info(this.alias, '已设置等待时间', this.sleepTime, ', ', torrent.name, '发布时间为', moment(torrent.pubTime * 1000).format('YYYY-MM-DD HH:mm:ss'), ', 跳过');
              await redis.setWithExpire(`vertex:scrape:free:${torrent.hash}`, '7777', 3600 * 4);
            } else {
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 非免费种']);
            }
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 非免费种');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取免费种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取免费种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      if (this.scrapeHr) {
        try {
          if (await util.scrapeHr(torrent.link, this.cookie)) {
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: HR']);
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: HR');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取 HR 种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取 HR 种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      let fitRule = {};
      if (fitRules.length > 0) {
        const highestPriority = Math.max(...fitRules.map(rule => +rule.priority));
        const highestPriorityRules = fitRules.filter(rule => +rule.priority === highestPriority);
        fitRule = highestPriorityRules[Math.floor(Math.random() * highestPriorityRules.length)];
      }
      let savePath = fitRule.savePath || this.savePath;
      if (savePath) {
        savePath = savePath.replace('{RANDOM}', util.uuid.v4().replace(/-/g, ''));
      }
      const category = fitRule.category || this.category;
      const client = fitRule.client ? global.runningClient[fitRule.client] : _client;
      // 在这里检查是否存在相同大小的种子
      if (this.skipSameTorrent) {
        // 1. 首先检查Redis缓存中是否存在相同种子（按特定客户端）
        const existCheck = await this.checkTorrentExistsInClient(client.id, torrent);
        if (existCheck && existCheck.exists) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, existCheck.reason]);
          await this.ntf.rejectTorrent(this._rss, client, torrent, existCheck.reason);
          return;
        }
        
        // 2. 检查数据库中是否有相同哈希的种子（仅检查哈希完全匹配 - 10分钟内）
        const checkTime = 600; // 10分钟
        const sameTorrent = await util.getRecord(
          'SELECT * FROM torrents WHERE hash = ? AND add_time > ? AND record_type = 1', 
          [torrent.hash, moment().unix() - checkTime]
        );
        
        if (sameTorrent && sameTorrent.id) {
          const reason = '拒绝原因: 种子已添加过';
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, reason]);
          await this.ntf.rejectTorrent(this._rss, client, torrent, reason);
          return;
        }
        
        // 3. 作为后备，检查最终选定的客户端中是否有相同大小的种子
        if (client && client.maindata && client._client.type === 'qBittorrent') {
          for (const _torrent of client.maindata.torrents) {
            if (+_torrent.size === +torrent.size) {
              // 将这个种子也缓存到Redis中，防止下次重复检查
              await this.cacheTorrentToClient(client.id, _torrent);
              
              const reason = '拒绝原因: 下载器中已存在同大小种子';
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, reason]);
              await this.ntf.rejectTorrent(this._rss, client, torrent, reason);
              return;
            }
          }
        }
      }
      try {
        let truehash = '';
        this.addCount += 1;
        if (this.pushTorrentFile) {
          const { filepath, hash } = await this._downloadTorrent(torrent.url, torrent.hash);
          truehash = hash;
          await client.addTorrentByTorrentFile(filepath, hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused);
        } else {
          if (this.useCustomRegex) {
            const match = this.regexStr.match(/^\/(.*)\/([gimuy]*)$/);
            if (match) {
              const [, pattern, flags] = match;
              const regex = new RegExp(pattern, flags);
              await client.addTorrent(torrent.url.replace(regex, this.replaceStr), torrent.hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused);
            }
          } else {
            await client.addTorrent(torrent.url, torrent.hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused);
          }
        }
        
        // 将种子添加到Redis缓存，用于跳过相同种子检查
        await this.cacheTorrentToClient(client.id, torrent);
        if (truehash && torrent.hash !== truehash) {
          // 如果有真实hash不同于原始hash，也缓存它
          await this.cacheTorrentToClient(client.id, { ...torrent, hash: truehash });
        }
        
        try {
          await this.ntf.addTorrent(this._rss, client, torrent);
        } catch (e) {
          logger.error('通知信息发送失败: \n', e);
        }
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, category, record_time, add_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, category, moment().unix(), moment().unix(), 1, '添加种子']);
        if (truehash && torrent.hash !== truehash) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, category, record_time, add_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [truehash, torrent.name, torrent.size, this.id, torrent.link, category, moment().unix(), moment().unix(), 1, '添加种子']);
        }
      } catch (error) {
        logger.error(this.alias, '下载器', client.alias, '添加种子失败:', error.message);
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 3, '添加种子失败']);
        try {
          await this.ntf.addTorrentError(this._rss, client, torrent);
        } catch (e) {
          logger.error('通知信息发送失败: \n', e);
        }
      }
    }
  }

  async rss (_torrents) {
    let torrents = [];
    if (_torrents) {
      torrents = _torrents;
    } else {
      // 从多个URL获取种子并合并
      torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
      
      // 根据hash去重，防止不同URL源提供相同种子
      const uniqueTorrents = [];
      const hashSet = new Set();
      for (const torrent of torrents) {
        if (!hashSet.has(torrent.hash)) {
          hashSet.add(torrent.hash);
          uniqueTorrents.push(torrent);
        }
      }
      torrents = uniqueTorrents;
    }
    
    // 过滤掉已处理和被冻结的种子和超过每小时推送上限的种子
    let newTorrents = [];
    
    // 过滤种子
    for (const torrent of torrents) {
      // 检查是否在数据库中已存在
      const sqlRes = await util.getRecord('SELECT * FROM torrents WHERE hash = ? AND rss_id = ?', [torrent.hash, this.id]);
      if (sqlRes && sqlRes.id) continue;
      // 检查是否被冻结
      if (torrent.name.indexOf('[FROZEN]') !== -1) continue;
      
      // 检查拒绝规则
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝规则: ${rejectRule.alias}`]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝规则: ${rejectRule.alias}`);
          reject = true;
          break;
        }
      }
      if (reject) continue;
      
      newTorrents.push(torrent);
    }
    
    // 如果没有有效种子，直接返回
    if (newTorrents.length === 0) {
      this.lastRssTime = moment().unix();
      return;
    }
    
    // 获取所有可用的下载器
    const availableClients = this.clientArr
      .map(item => global.runningClient[item])
      .filter(item => {
        return !!item && !!item.status && !!item.maindata &&
          (!this.maxClientUploadSpeed || this.maxClientUploadSpeed > item.avgUploadSpeed) &&
          (!this.maxClientDownloadSpeed || this.maxClientDownloadSpeed > item.avgDownloadSpeed) &&
          (!this.maxClientDownloadCount || this.maxClientDownloadCount > item.maindata.leechingCount);
      })
      .filter(item => {
        return (!item.maxDownloadSpeed || item.maxDownloadSpeed > item.avgDownloadSpeed) &&
          (!item.maxUploadSpeed || item.maxUploadSpeed > item.avgUploadSpeed) &&
          (!item.maxLeechNum || item.maxLeechNum > item.maindata.leechingCount) &&
          (!item.minFreeSpace || item.minFreeSpace < item.maindata.freeSpaceOnDisk);
      });
    
    // 将"无可用下载器"判断移至过滤后，只对需要处理的种子记录错误
    if (availableClients.length === 0) {
      logger.error(this.alias, '无可用下载器');
      for (const torrent of newTorrents) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 无可用下载器']);
        await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 无可用下载器');
      }
      return;
    }

    // 检查每小时推送上限
    if (this.addCount + newTorrents.length > this.addCountPerHour) {
      // 计算可接受的种子数量和需要拒绝的种子数量
      const acceptableCount = this.addCountPerHour - this.addCount;
      
      // 如果有可接受的种子，则按大小排序，优先处理大种子
      if (acceptableCount > 0) {
        // 对种子按大小排序（从大到小）
        newTorrents.sort((a, b) => +b.size - +a.size);
        
        // 分割为可接受的和需要拒绝的
        const acceptableTorrents = newTorrents.slice(0, acceptableCount);
        const rejectedTorrents = newTorrents.slice(acceptableCount);
        
        // 记录被拒绝的种子
        for (const torrent of rejectedTorrents) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`);
        }
        
        // 继续处理可接受的种子
        logger.info(this.alias, `每小时推送上限为 ${this.addCountPerHour}，当前已推送 ${this.addCount}，本次接受 ${acceptableTorrents.length} 个种子，拒绝 ${rejectedTorrents.length} 个种子`);
        
        // 更新newTorrents为可接受的种子列表，继续后续处理
        newTorrents = acceptableTorrents;
      } else {
        // 如果没有可接受的种子（已达上限），拒绝所有种子
        for (const torrent of newTorrents) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`);
        }
        return;
      }
    }
    
    // 检查最长休眠时间
    if (moment().unix() - this.lastRssTime > +this.maxSleepTime) {
      for (const torrent of newTorrents) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 最长休眠时间']);
        await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 最长休眠时间');
      }
      this.lastRssTime = moment().unix();
      return;
    }
    
    // 智能分配种子到下载器
    const clientAssignments = {};
    
    // 计算下载器的权重（考虑最大上传速度）
    const clientWeights = {};
    
    // 计算所有下载器的最大上传速度总和，用于归一化权重
    const totalMaxUploadSpeed = availableClients.reduce((sum, client) => {
      // 如果客户端未设置最大上传速度，默认为10Gbps (约1250MB/s)
      const speed = client.maxUploadSpeed || 1250000000;
      return sum + speed;
    }, 0);
    
    // 为所有下载器计算权重
    const minWeight = 0.5;
    const maxWeight = 10; // 从5增加到10，扩大区分度
    availableClients.forEach(client => {
      // 计算客户端权重（基于最大上传速度）
      const clientSpeed = client.maxUploadSpeed || 1250000000;
      // 使用平方根映射代替线性映射，更合理地反映带宽差异
      const uploadSpeedWeight = Math.sqrt(clientSpeed) / Math.sqrt(totalMaxUploadSpeed);
      // 权重值在0.5到10之间浮动，避免极端值
      clientWeights[client.id] = minWeight + uploadSpeedWeight * (maxWeight - minWeight);
      
      logger.debug(`下载器: ${client.alias}, 最大上传速度: ${util.formatSize(clientSpeed)}/s, 平方根权重比: ${uploadSpeedWeight.toFixed(4)}, 最终权重: ${clientWeights[client.id].toFixed(2)}`);
    });
    
    // 当排序规则是"当前剩余空间"时，进行智能均匀分配
    if (this.clientSortBy === 'freeSpaceOnDisk') {
      const clientTotalSize = {};
      const clientTorrentCount = {};
      
      // 计算每个下载器的实际可用空间（考虑已使用空间的20%可能会被释放）
      const clientAvailableSpace = {};
      
      availableClients.forEach(client => {
        // 已使用空间的20%可能会被自动删种释放
        const potentialReleaseSpace = (client.maindata.usedSpace || 0) * 0.2;
        // 实际可用空间 = 当前剩余空间 + 潜在可释放空间
        clientAvailableSpace[client.id] = client.maindata.freeSpaceOnDisk + potentialReleaseSpace;
        
        logger.debug(`下载器: ${client.alias}, 当前剩余空间: ${util.formatSize(client.maindata.freeSpaceOnDisk)}, ` +
                    `已使用空间: ${util.formatSize(client.maindata.usedSpace || 0)}, ` +
                    `潜在可释放空间: ${util.formatSize(potentialReleaseSpace)}, ` +
                    `计算后可用空间: ${util.formatSize(clientAvailableSpace[client.id])}`);
      });
      
      // 初始化客户端分配统计
      availableClients.forEach(client => {
        clientAssignments[client.id] = [];
        clientTotalSize[client.id] = 0;
        clientTorrentCount[client.id] = 0;
      });
      
      // 按种子大小从大到小排序，确保大种子优先分配
      newTorrents.sort((a, b) => +b.size - +a.size);
      
      // 新的均匀分配算法
      const skippedTorrents = []; // 存储因空间不足暂时被跳过的种子
      
      // 第一轮：每个下载器分配大种子
      for (const torrent of newTorrents) {
        // 找到当前分配种子数最少且有足够空间的下载器
        const eligibleClients = availableClients.filter(client => 
          clientAvailableSpace[client.id] > clientTotalSize[client.id] + +torrent.size
        );
        
        if (eligibleClients.length === 0) {
          // 所有下载器都没有足够空间，将种子放入跳过列表
          skippedTorrents.push(torrent);
          continue;
        }
        
        // 按照加权的种子分配数量排序
        // 权重高的下载器应该分配更多种子，因此加权计数会比实际计数低一些
        eligibleClients.sort((a, b) => 
          clientTorrentCount[a.id] / clientWeights[a.id] - 
          clientTorrentCount[b.id] / clientWeights[b.id]
        );
        
        // 分配给加权种子数量最少的下载器
        const selectedClient = eligibleClients[0];
        clientAssignments[selectedClient.id].push(torrent);
        clientTotalSize[selectedClient.id] += +torrent.size;
        clientTorrentCount[selectedClient.id]++;
      }
      
      // 第二轮：尝试分配被跳过的种子到空间仍然足够的下载器
      if (skippedTorrents.length > 0) {
        logger.debug(this.alias, `第一轮分配后有 ${skippedTorrents.length} 个种子因空间不足被跳过，尝试第二轮分配`);
        
        for (const torrent of skippedTorrents) {
          // 按照上传速度权重排序选择下载器
          const eligibleClients = availableClients.filter(client => 
            clientAvailableSpace[client.id] > clientTotalSize[client.id] + +torrent.size
          );
          
          if (eligibleClients.length > 0) {
            // 优先考虑上传速度较高的下载器
            eligibleClients.sort((a, b) => clientWeights[b.id] - clientWeights[a.id]);
            
            const selectedClient = eligibleClients[0];
            clientAssignments[selectedClient.id].push(torrent);
            clientTotalSize[selectedClient.id] += +torrent.size;
            clientTorrentCount[selectedClient.id]++;
            logger.debug(this.alias, `种子 ${torrent.name} (${util.formatSize(torrent.size)}) 在第二轮成功分配给 ${selectedClient.alias}，上传速度权重: ${clientWeights[selectedClient.id].toFixed(2)}`);
          } else {
            // 仍然没有下载器有足够空间，记录拒绝原因
            logger.warn(this.alias, `种子 ${torrent.name} (${util.formatSize(torrent.size)}) 无法分配，所有下载器空间不足`);
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 所有下载器空间不足']);
            await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 所有下载器空间不足');
          }
        }
      }
      
      // 输出分配统计信息到日志
      logger.debug(this.alias, '均匀种子分配结果:');
      for (const clientId in clientTorrentCount) {
        const client = global.runningClient[clientId];
        const spaceUtilization = ((clientTotalSize[clientId] / clientAvailableSpace[clientId]) * 100).toFixed(2);
        logger.debug(`下载器: ${client.alias}, 分配种子数: ${clientTorrentCount[clientId]}, ` +
                    `最大上传速度: ${util.formatSize(client.maxUploadSpeed || 0)}/s, ` +
                    `上传速度权重: ${clientWeights[clientId].toFixed(2)}, ` +
                    `总大小: ${util.formatSize(clientTotalSize[clientId])}, ` +
                    `空间利用率: ${spaceUtilization}%, ` +
                    `计算后剩余空间: ${util.formatSize(clientAvailableSpace[clientId] - clientTotalSize[clientId])}`);
      }
    } else if (this.clientSortBy === 'uploadSpeed') {
      // 专门针对上传速度进行的智能分配 - 优先分配给上传速度低但带宽高的下载器
      const clientTorrentCount = {};
      
      // 初始化客户端分配统计
      availableClients.forEach(client => {
        clientAssignments[client.id] = [];
        clientTorrentCount[client.id] = 0;
      });
      
      // 按种子大小从大到小排序，确保大种子优先分配
      newTorrents.sort((a, b) => +b.size - +a.size);
      
      // 对于每个种子，都按照"当前上传速度/权重"排序下载器
      // 这样上传速度低但带宽高的下载器会优先获得种子
      for (const torrent of newTorrents) {
        // 按照加权的当前上传速度排序
        const sortedClients = [...availableClients].sort((a, b) => 
          (a.maindata.uploadSpeed / clientWeights[a.id]) - 
          (b.maindata.uploadSpeed / clientWeights[b.id])
        );
        
        // 考虑种子分配数量来平衡负载
        // 找出分配数量最少的前30%下载器
        const clientCount = sortedClients.length;
        const topClients = sortedClients.slice(0, Math.max(1, Math.floor(clientCount * 0.3)));
        
        // 在前30%中找当前种子数最少的
        topClients.sort((a, b) => clientTorrentCount[a.id] - clientTorrentCount[b.id]);
        
        // 分配给选中的下载器
        const selectedClient = topClients[0];
        clientAssignments[selectedClient.id].push(torrent);
        clientTorrentCount[selectedClient.id]++;
      }
      
      // 输出分配统计信息到日志
      logger.debug(this.alias, '带宽加权上传速度分配结果:');
      for (const clientId in clientTorrentCount) {
        const client = global.runningClient[clientId];
        logger.debug(`下载器: ${client.alias}, 分配种子数: ${clientTorrentCount[clientId]}, ` +
                    `当前上传速度: ${util.formatSize(client.maindata.uploadSpeed)}/s, ` +
                    `最大上传速度: ${util.formatSize(client.maxUploadSpeed || 0)}/s, ` +
                    `上传速度权重: ${clientWeights[clientId].toFixed(2)}, ` +
                    `加权上传速度: ${util.formatSize(client.maindata.uploadSpeed / clientWeights[clientId])}/s`);
      }
    } else {
      // 其他排序规则，使用带宽权重的轮询分配
      const clientTorrentCount = {};
      
      // 初始化客户端分配统计
      availableClients.forEach(client => {
        clientAssignments[client.id] = [];
        clientTorrentCount[client.id] = 0;
      });
      
      // 按照下载器排序方式排序
      const sortedClients = [...availableClients].sort((a, b) => 
        (this.clientSortBy === 'freeSpaceOnDisk' ? -1 : 1) *
        (a.maindata[this.clientSortBy] - b.maindata[this.clientSortBy])
      );
      
      // 计算总权重
      const totalWeight = sortedClients.reduce((sum, client) => sum + clientWeights[client.id], 0);
      // 计算每个下载器应该分配的种子比例
      const allocations = {};
      sortedClients.forEach(client => {
        allocations[client.id] = Math.ceil((clientWeights[client.id] / totalWeight) * newTorrents.length);
      });
      
      // 根据权重分配种子
      let currentIndex = 0;
      for (const client of sortedClients) {
        const allocation = allocations[client.id];
        for (let i = 0; i < allocation && currentIndex < newTorrents.length; i++) {
          clientAssignments[client.id].push(newTorrents[currentIndex]);
          clientTorrentCount[client.id]++;
          currentIndex++;
        }
      }
      
      // 如果还有剩余种子，按轮询方式分配
      while (currentIndex < newTorrents.length) {
        for (const client of sortedClients) {
          if (currentIndex < newTorrents.length) {
            clientAssignments[client.id].push(newTorrents[currentIndex]);
            clientTorrentCount[client.id]++;
            currentIndex++;
          } else {
            break;
          }
        }
      }
      
      // 输出带权重轮询分配结果
      logger.debug(this.alias, '带权重轮询分配结果:');
      for (const clientId in clientTorrentCount) {
        const client = global.runningClient[clientId];
        logger.debug(`下载器: ${client.alias}, 分配种子数: ${clientTorrentCount[clientId]}, ` +
                    `最大上传速度: ${util.formatSize(client.maxUploadSpeed || 0)}/s, ` + 
                    `上传速度权重: ${clientWeights[clientId].toFixed(2)}, ` +
                    `权重分配比例: ${Math.round((clientWeights[clientId] / totalWeight) * 100)}%`);
      }
    }
    
    // 处理每个下载器的种子分配
    for (const clientId in clientAssignments) {
      const client = global.runningClient[clientId];
      const clientTorrents = clientAssignments[clientId];
      
      // 在处理种子前先尝试锁定它们，防止并发处理
      for (const torrent of clientTorrents) {
        // 创建一个临时锁，默认锁定5分钟
        const lockKey = `vertex:torrent:lock:${torrent.hash}`;
        let torrentLock = null;
        
        try {
          // 尝试获取分布式锁，锁定时间5分钟（300000毫秒）
          torrentLock = await redlock.lock(lockKey, 300000);
          logger.debug(this.alias, `获取种子 ${torrent.name} 锁成功`);
          
          try {
            // 再次检查数据库，确保在获取锁的过程中种子没有被添加
            const torrentExists = await util.getRecord('SELECT id FROM torrents WHERE hash = ? AND rss_id = ?', 
              [torrent.hash, this.id]);
              
            if (torrentExists && torrentExists.id) {
              logger.info(this.alias, `种子 ${torrent.name} 在锁定过程中已被其他进程处理，跳过`);
              continue;
            }
            
            // 处理种子
            await this._pushTorrent(torrent, client);
          } catch (error) {
            logger.error(this.alias, `处理种子 ${torrent.name} 时出错:`, error);
          }
        } catch (lockErr) {
          if (lockErr.name === 'LockError') {
            // 无法获取锁，说明种子可能正在被其他进程处理
            logger.info(this.alias, `种子 ${torrent.name} 已被其他进程锁定，跳过`);
            
            // 记录跳过原因
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 正在被其他进程处理']);
          } else {
            // 其他锁错误
            logger.error(this.alias, `获取种子 ${torrent.name} 锁时出错:`, lockErr);
          }
        } finally {
          // 释放锁（如果成功获取了）
          if (torrentLock) {
            try {
              await torrentLock.unlock();
              logger.debug(this.alias, `释放种子 ${torrent.name} 锁成功`);
            } catch (unlockErr) {
              logger.error(this.alias, `释放种子 ${torrent.name} 锁失败:`, unlockErr);
            }
          }
        }
      }
    }
    
    this.lastRssTime = moment().unix();
  }

  async dryrun () {
    const torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (this.acceptRules.length === 0) {
        torrent.status = '无选择规则, 默认选中该种子';
        continue;
      } else if (fitRules.length === 0) {
        torrent.status = '未匹配到规则';
        continue;
      } else {
        torrent.status = '匹配到选择规则: ' + fitRules[0].alias;
        continue;
      }
    }
    return torrents;
  }

  async mikanSearch (name) {
    const torrents = await util.mikanSearch(name);
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (this.acceptRules.length === 0) {
        torrent.status = '无选择规则, 默认选中该种子';
        continue;
      } else if (fitRules.length === 0) {
        torrent.status = '未匹配到规则';
        continue;
      } else {
        torrent.status = '匹配到选择规则: ' + fitRules[0].alias;
        continue;
      }
    }
    return torrents;
  }

  /**
   * 测试锁机制的正确性
   * @param {string} torrentHash - 可选的种子哈希用于测试种子锁
   * @return {Object} 测试结果
   */
  async testLockMechanism(torrentHash) {
    const results = {
      globalLock: { status: 'untested' },
      torrentLock: { status: 'untested' },
      redisMethods: {
        setnx: typeof redis.setnx === 'function',
        keys: typeof redis.keys === 'function',
        get: typeof redis.get === 'function',
        set: typeof redis.set === 'function',
        del: typeof redis.del === 'function',
        expire: typeof redis.expire === 'function'
      },
      redlockAvailable: typeof redlock === 'object' && typeof redlock.lock === 'function'
    };
    
    // 测试全局锁
    const globalLockKey = `vertex:rss:global:${this.id}:test`;
    try {
      const lock = await redlock.lock(globalLockKey, 5000); // 锁定5秒
      results.globalLock.status = 'acquired';
      
      // 验证锁是否真的起作用
      try {
        const secondLock = await redlock.lock(globalLockKey, 1000);
        await secondLock.unlock();
        results.globalLock.status = 'failed-double-acquire'; // 不应该能够获取到第二个锁
      } catch (e) {
        results.globalLock.status = 'exclusive'; // 正确，无法获取第二个锁
      }
      
      // 释放第一个锁
      await lock.unlock();
      results.globalLock.status = 'success';
    } catch (e) {
      results.globalLock.error = e.message;
      results.globalLock.status = 'error';
    }
    
    // 如果提供了种子哈希，测试种子锁
    if (torrentHash) {
      const torrentLockKey = `vertex:torrent:lock:${torrentHash}:test`;
      try {
        const lock = await redlock.lock(torrentLockKey, 5000);
        results.torrentLock.status = 'acquired';
        await lock.unlock();
        results.torrentLock.status = 'success';
      } catch (e) {
        results.torrentLock.error = e.message;
        results.torrentLock.status = 'error';
      }
    }
    
    // 检查Redis中可能存在的遗留锁
    try {
      const globalLocks = await redis.keys(`vertex:rss:global:*`);
      const torrentLocks = await redis.keys(`vertex:torrent:lock:*`);
      
      results.existingLocks = {
        globalLocks: globalLocks.length,
        torrentLocks: torrentLocks.length,
        globalLocksList: globalLocks,
        torrentLocksList: torrentLocks
      };
    } catch (e) {
      results.existingLocks = { error: e.message };
    }
    
    return results;
  }
}
module.exports = Rss;
