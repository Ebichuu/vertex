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
const RssTaskQueue = require('../libs/queues/RssTaskQueue');
const Push = require('./Push');

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
    
    // 初始化任务队列（全局单例）
    if (!global.rssTaskQueue) {
      global.rssTaskQueue = new RssTaskQueue();
    }
    this.taskQueue = global.rssTaskQueue;
    this.acceptRules = util.listRssRule().filter(item => (this._acceptRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.rejectRules = util.listRssRule().filter(item => (this._rejectRules.indexOf(item.id) !== -1)).sort((a, b) => +b.priority - +a.priority);
    this.downloadLimit = util.calSize(rss.downloadLimit, rss.downloadLimitUnit);
    this.uploadLimit = util.calSize(rss.uploadLimit, rss.uploadLimitUnit);
    this.maxClientUploadSpeed = util.calSize(rss.maxClientUploadSpeed, rss.maxClientUploadSpeedUnit);
    this.maxClientDownloadSpeed = util.calSize(rss.maxClientDownloadSpeed, rss.maxClientDownloadSpeedUnit);
    this.maxClientDownloadCount = +rss.maxClientDownloadCount;
    this.isRunning = false;
    if (!rss.dryrun) {
      // 修改为入队操作
      this.rssJob = cron.schedule(rss.cron, () => this.scheduleRssFetch());
      this.clearCount = cron.schedule('0 * * * *', () => this.scheduleClearCount());
      
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
    
    // 设置实例为非运行状态
    this.isRunning = false;
    
    delete global.runningRss[this.id];
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
    const startTime = moment();
    logger.debug(this.alias, 'RSS任务开始执行');
    
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
    
    logger.debug(this.alias, `获取种子完成，耗时: ${moment().diff(startTime, 'seconds')}秒，数量: ${torrents.length}`);
    
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
    
    logger.debug(this.alias, `种子过滤完成，耗时: ${moment().diff(startTime, 'seconds')}秒，有效数量: ${newTorrents.length}`);
    
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
    
    // 当排序规则是"当前剩余空间"时，进行高带宽优先的智能分配
    if (this.clientSortBy === 'freeSpaceOnDisk') {
      const clientTotalSize = {};
      const clientTorrentCount = {};
      
      // 计算每个下载器的实际可用空间（考虑已使用空间的20%可能会被释放）
      const clientAvailableSpace = {};
      
      // 存储介质分类 (HDD/SSD)
      const storageType = {};
      
      // 识别高带宽客户端 (>=2Gbps, 约250MB/s)
      const highBandwidthThreshold = 250000000;
      const highBandwidthClients = [];
      const normalBandwidthClients = [];
      
      // 计算客户端的真实带宽（因为用户设置的是10倍于实际值）
      const realBandwidth = {};
      
      availableClients.forEach(client => {
        // 估算真实带宽（除以10，因为用户说设置为实际的10倍）
        const estimatedRealBandwidth = client.maxUploadSpeed ? client.maxUploadSpeed / 10 : 125000000; // 默认1Gbps
        realBandwidth[client.id] = estimatedRealBandwidth;
        
                 // 识别存储介质类型（优先从别名判断，再考虑空间大小）
         // 客户端别名中包含hdd字样的视为HDD，包含ssd字样的视为SSD
         // 如果别名没有明确标识，则大于1TB认为是HDD
         let isHDD = false;
         if (client.alias) {
           const lowerAlias = client.alias.toLowerCase();
           if (lowerAlias.includes('hdd')) {
             isHDD = true;
           } else if (lowerAlias.includes('ssd')) {
             isHDD = false;
           } else {
             // 没有明确标识时，按照空间大小判断
             isHDD = client.maindata.freeSpaceOnDisk > 1000 * 1024 * 1024 * 1024;
           }
         } else {
           // 没有别名时，按照空间大小判断
           isHDD = client.maindata.freeSpaceOnDisk > 1000 * 1024 * 1024 * 1024;
         }
         storageType[client.id] = isHDD ? 'HDD' : 'SSD';
        
        // 根据带宽分类
        if (estimatedRealBandwidth >= highBandwidthThreshold) {
          highBandwidthClients.push(client);
        } else {
          normalBandwidthClients.push(client);
        }
        
        // 已使用空间的20%可能会被自动删种释放
        const potentialReleaseSpace = (client.maindata.usedSpace || 0) * 0.2;
        // 实际可用空间 = 当前剩余空间 + 潜在可释放空间
        clientAvailableSpace[client.id] = client.maindata.freeSpaceOnDisk + potentialReleaseSpace;
        
        logger.debug(`下载器: ${client.alias}, 类型: ${storageType[client.id]}, 实际带宽: ${util.formatSize(estimatedRealBandwidth)}/s, ` +
                    `当前剩余空间: ${util.formatSize(client.maindata.freeSpaceOnDisk)}, ` +
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
      
      // 种子分类和排序
      // 1. 按大小分类：小型种子(<5GB)、中型种子(5GB-50GB)、大型种子(>50GB)
      const smallTorrents = [];
      const mediumTorrents = [];
      const largeTorrents = [];
      
      // 2. 估计种子热度（基于大小）
      const torrentHotness = {};
      
       // 收集种子信息用于智能分配
       newTorrents.forEach(torrent => {
         // 由于这些是保种区种子，发布时间较长但做种人数少
         // 不考虑新鲜度，主要根据体积大小评估热度
         
         // 热度计算：
         // 1. 体积评分(0-10)：小体积种子更容易获得更多上传量
         const sizeGB = +torrent.size / (1024 * 1024 * 1024);
         // 小于5GB获得10分，5-20GB线性降至5分，>20GB降低更快
         let sizeScore = 0;
         if (sizeGB <= 5) {
           sizeScore = 10; // 极小种子最高分
         } else if (sizeGB <= 20) {
           sizeScore = 10 - ((sizeGB - 5) / 15) * 5; // 5-20GB线性降至5分
         } else {
           sizeScore = 5 - Math.min(5, (sizeGB - 20) / 60 * 5); // 20-80GB线性降至0分
         }
         
         // 2. 保种价值评分(0-5)：考虑特殊因素
         // 注: 这里可以添加更多特征判断，如种子名称中包含特定关键词等
         let preserveScore = 3; // 默认中等保种价值
         
         // 如果种子名称中包含某些特殊关键词，可能表明它更有价值
         if (torrent.name) {
           const lowerName = torrent.name.toLowerCase();
           // 举例：包含特定分辨率、稀有资源等关键词可能更有价值
           if (lowerName.includes('1080p') || lowerName.includes('电视剧')) {
             preserveScore += 1;
           }
         }
         
         // 总热度得分
         torrentHotness[torrent.hash] = sizeScore + preserveScore;
        
                 // 使用前面计算的sizeGB进行种子分类
         if (sizeGB < 5) {
           smallTorrents.push(torrent);
         } else if (sizeGB < 50) {
           mediumTorrents.push(torrent);
         } else {
           largeTorrents.push(torrent);
         }
      });
      
      // 对每个分类的种子按热度排序
      smallTorrents.sort((a, b) => torrentHotness[b.hash] - torrentHotness[a.hash]);
      mediumTorrents.sort((a, b) => torrentHotness[b.hash] - torrentHotness[a.hash]);
      largeTorrents.sort((a, b) => torrentHotness[b.hash] - torrentHotness[a.hash]);
      
      // 设置分配比例：高带宽客户端应该获得更多的热门小种子
      const highBandwidthSmallTorrentRatio = highBandwidthClients.length > 0 ? 0.8 : 0;
      const highBandwidthMediumTorrentRatio = highBandwidthClients.length > 0 ? 0.5 : 0;
      
      // 智能分配函数
      const allocateTorrents = async (torrents, highBwRatio = 0, preferredStorageType = null) => {
        // 计算分配给高带宽客户端的种子数量
        const highBwCount = Math.ceil(torrents.length * highBwRatio);
        
        // 分配给高带宽客户端的种子
        const highBwTorrents = torrents.slice(0, highBwCount);
        // 分配给普通带宽客户端的种子
        const normalBwTorrents = torrents.slice(highBwCount);
        
        // 1. 给高带宽客户端分配热度较高的种子
        if (highBwTorrents.length > 0 && highBandwidthClients.length > 0) {
          // 按带宽降序排列高带宽客户端
          const sortedHighBwClients = [...highBandwidthClients].sort((a, b) => 
            realBandwidth[b.id] - realBandwidth[a.id]
          );
          
          // 平均分配策略
          let currentClientIndex = 0;
          
          for (const torrent of highBwTorrents) {
            // 循环选择高带宽客户端
            let assigned = false;
            let startIndex = currentClientIndex;
            
            do {
              const client = sortedHighBwClients[currentClientIndex];
              // 检查是否有足够空间
              if (clientAvailableSpace[client.id] > clientTotalSize[client.id] + +torrent.size) {
                clientAssignments[client.id].push(torrent);
                clientTotalSize[client.id] += +torrent.size;
                clientTorrentCount[client.id]++;
                assigned = true;
                
                logger.debug(`高带宽分配: 种子 "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) 分配给高带宽下载器 ${client.alias} (${util.formatSize(realBandwidth[client.id])}/s)`);
                
                // 移动到下一个客户端
                currentClientIndex = (currentClientIndex + 1) % sortedHighBwClients.length;
                break;
              }
              
              // 尝试下一个客户端
              currentClientIndex = (currentClientIndex + 1) % sortedHighBwClients.length;
            } while (currentClientIndex !== startIndex);
            
            // 如果无法分配给高带宽客户端，添加到常规带宽种子列表
            if (!assigned) {
              normalBwTorrents.push(torrent);
            }
          }
        } else if (highBwTorrents.length > 0) {
          // 如果没有高带宽客户端可用，将所有种子添加到常规列表
          normalBwTorrents.push(...highBwTorrents);
        }
        
        // 2. 给普通带宽客户端分配剩余种子（考虑存储类型偏好）
        if (normalBwTorrents.length > 0) {
          // 如果指定了存储类型偏好，优先使用该类型的客户端
          let priorityClients = availableClients;
          let fallbackClients = [];
          
          if (preferredStorageType) {
            priorityClients = availableClients.filter(client => 
              storageType[client.id] === preferredStorageType
            );
            fallbackClients = availableClients.filter(client => 
              storageType[client.id] !== preferredStorageType
            );
          }
          
          // 合并已分配种子到跳过列表
          const skippedTorrents = [];
          
          // 先尝试分配到首选客户端
          for (const torrent of normalBwTorrents) {
            // 找到符合条件的客户端（考虑空间和分配平衡）
            const eligibleClients = priorityClients.filter(client => 
              clientAvailableSpace[client.id] > clientTotalSize[client.id] + +torrent.size
            );
            
            if (eligibleClients.length === 0) {
              // 无符合条件的首选客户端，添加到跳过列表
              skippedTorrents.push(torrent);
              continue;
            }
            
            // 优先分配给已分配种子数量/权重比最低的客户端
            eligibleClients.sort((a, b) => 
              (clientTorrentCount[a.id] / clientWeights[a.id]) - 
              (clientTorrentCount[b.id] / clientWeights[b.id])
            );
            
            // 分配种子
            const selectedClient = eligibleClients[0];
            clientAssignments[selectedClient.id].push(torrent);
            clientTotalSize[selectedClient.id] += +torrent.size;
            clientTorrentCount[selectedClient.id]++;
            
            logger.debug(`普通分配: 种子 "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) 分配给下载器 ${selectedClient.alias} (${storageType[selectedClient.id]}, ${util.formatSize(realBandwidth[selectedClient.id])}/s)`);
          }
          
          // 尝试将跳过的种子分配给备选客户端
          if (skippedTorrents.length > 0 && fallbackClients.length > 0) {
            logger.debug(this.alias, `有 ${skippedTorrents.length} 个种子无法分配给首选${preferredStorageType}客户端，尝试分配给备选客户端`);
            
            for (const torrent of skippedTorrents) {
              // 找到符合条件的备选客户端
              const eligibleClients = fallbackClients.filter(client => 
                clientAvailableSpace[client.id] > clientTotalSize[client.id] + +torrent.size
              );
              
              if (eligibleClients.length === 0) {
                // 记录无法分配的种子
                logger.warn(this.alias, `种子 "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) 无法分配，所有下载器空间不足`);
                await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                  [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 所有下载器空间不足']);
                await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 所有下载器空间不足');
                continue;
              }
              
              // 优先考虑带宽较高的备选客户端
              eligibleClients.sort((a, b) => realBandwidth[b.id] - realBandwidth[a.id]);
              
              // 分配种子
              const selectedClient = eligibleClients[0];
              clientAssignments[selectedClient.id].push(torrent);
              clientTotalSize[selectedClient.id] += +torrent.size;
              clientTorrentCount[selectedClient.id]++;
              
              logger.debug(`备选分配: 种子 "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) 分配给备选下载器 ${selectedClient.alias} (${storageType[selectedClient.id]}, ${util.formatSize(realBandwidth[selectedClient.id])}/s)`);
            }
          } else if (skippedTorrents.length > 0) {
            // 记录所有无法分配的种子
            for (const torrent of skippedTorrents) {
              logger.warn(this.alias, `种子 "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) 无法分配，所有下载器空间不足`);
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 所有下载器空间不足']);
              await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 所有下载器空间不足');
            }
          }
        }
      };
      
      // 根据种子大小和客户端特性进行优化分配
      logger.debug(this.alias, `开始基于带宽和存储类型的智能分配，小型种子: ${smallTorrents.length}，中型种子: ${mediumTorrents.length}，大型种子: ${largeTorrents.length}`);
      
      // 顺序执行各类种子的分配
      // 1. 小型种子（优先分配给高带宽客户端，尤其是SSD客户端）
      await allocateTorrents(smallTorrents, highBandwidthSmallTorrentRatio, 'SSD');
      
      // 2. 中型种子（部分分配给高带宽客户端，SSD和HDD均可）
      await allocateTorrents(mediumTorrents, highBandwidthMediumTorrentRatio);
      
      // 3. 大型种子（优先分配给HDD客户端，适合长期做种）
      await allocateTorrents(largeTorrents, 0, 'HDD');
      
      // 输出分配统计信息到日志
      logger.debug(this.alias, '带宽和存储类型优化的分配结果:');
      for (const clientId in clientTorrentCount) {
        const client = global.runningClient[clientId];
        const spaceUtilization = ((clientTotalSize[clientId] / clientAvailableSpace[clientId]) * 100).toFixed(2);
        logger.debug(`下载器: ${client.alias}, 分配种子数: ${clientTorrentCount[clientId]}, ` +
                    `存储类型: ${storageType[clientId]}, ` +
                    `实际带宽: ${util.formatSize(realBandwidth[clientId])}/s, ` +
                    `上传速度权重: ${clientWeights[clientId].toFixed(2)}, ` +
                    `总大小: ${util.formatSize(clientTotalSize[clientId])}, ` +
                    `空间利用率: ${spaceUtilization}%, ` +
                    `计算后剩余空间: ${util.formatSize(clientAvailableSpace[clientId] - clientTotalSize[clientId])}`);
      }
    } else if (this.clientSortBy === 'uploadSpeed') {
      // 专门针对上传速度进行的智能分配 - 综合考虑服务器类型、下载任务数量和实际上传性能
      const clientTorrentCount = {};
      const clientUploadEfficiency = {};

      // 初始化客户端分配统计和效率评分
      availableClients.forEach(client => {
        clientAssignments[client.id] = [];
        clientTorrentCount[client.id] = 0;

        // 识别服务器类型
        const lowerAlias = (client.alias || '').toLowerCase();
        const isVPS = lowerAlias.includes('vps');
        const isHDD = lowerAlias.includes('hdd');
        const serverType = isVPS ? 'VPS' : (isHDD ? 'HDD独服' : 'SSD独服');

        // 真实带宽 = maxUploadSpeed / 10 (因为用户设置为实际的10倍)
        const realMaxUploadSpeed = client.maxUploadSpeed ? client.maxUploadSpeed / 10 : 125000000; // 默认1Gbps
        const currentUploadSpeed = client.maindata.uploadSpeed || 0;
        const downloadingCount = client.maindata.leechingCount || 0;

        // 计算剩余可用上传带宽
        const remainingUploadSpeed = Math.max(0, realMaxUploadSpeed - currentUploadSpeed);

        // 计算上传效率评分（0-100分）
        let efficiencyScore = 0;

        // 1. 剩余带宽评分 (0-50分) - 主要评分依据
        const remainingBandwidthGB = remainingUploadSpeed / 125000000; // 转换为Gbps
        const remainingBandwidthScore = Math.min(50, remainingBandwidthGB * 20); // 1Gbps剩余=20分，2.5Gbps剩余=50分

        // 2. 下载任务负载评分 (0-30分) - 考虑IO性能影响
        let loadScore = 30;
        if (downloadingCount > 0) {
          // 根据服务器类型调整下载任务的影响
          if (isHDD) {
            // HDD服务器IO性能差，下载任务影响更大
            loadScore = Math.max(0, 30 - downloadingCount * 4); // 每个下载任务扣4分
          } else {
            // VPS和SSD独服IO性能相当，下载任务影响相同
            loadScore = Math.max(5, 30 - downloadingCount * 2.5); // 每个下载任务扣2.5分
          }
        }

        // 3. 带宽稳定性评分 (0-20分) - 基于服务器类型
        let stabilityScore = 0;
        if (isHDD) {
          // HDD服务器稳定但IO受限
          stabilityScore = 15;
        } else if (isVPS) {
          // VPS资源共享，稳定性中等
          stabilityScore = 18;
        } else {
          // SSD独服最稳定
          stabilityScore = 20;
        }

        // 综合效率评分 = 剩余带宽评分 + 下载任务负载评分 + 带宽稳定性评分
        efficiencyScore = remainingBandwidthScore + loadScore + stabilityScore;
        clientUploadEfficiency[client.id] = efficiencyScore;

        logger.debug(`下载器: ${client.alias} (${serverType}), ` +
                    `真实带宽: ${util.formatSize(realMaxUploadSpeed)}/s, ` +
                    `当前上传: ${util.formatSize(currentUploadSpeed)}/s, ` +
                    `剩余带宽: ${util.formatSize(remainingUploadSpeed)}/s, ` +
                    `下载任务: ${downloadingCount}, ` +
                    `效率评分: ${efficiencyScore.toFixed(1)} (剩余带宽:${remainingBandwidthScore.toFixed(1)} 负载:${loadScore.toFixed(1)} 稳定性:${stabilityScore.toFixed(1)})`);
      });

      // 按种子大小从大到小排序，确保大种子优先分配
      newTorrents.sort((a, b) => +b.size - +a.size);

      // 对于每个种子，按效率评分进行智能分配
      for (const torrent of newTorrents) {
        // 按效率评分从高到低排序，同时考虑负载均衡
        const sortedClients = [...availableClients].sort((a, b) => {
          // 主要排序依据：效率评分（从高到低）
          const efficiencyDiff = clientUploadEfficiency[b.id] - clientUploadEfficiency[a.id];

          // 如果效率评分相近（差异小于5分），则考虑当前分配的种子数量进行负载均衡
          if (Math.abs(efficiencyDiff) < 5) {
            return clientTorrentCount[a.id] - clientTorrentCount[b.id];
          }

          return efficiencyDiff;
        });

        // 选择排序后的第一个客户端（效率最高且负载相对较轻）
        const selectedClient = sortedClients[0];
        clientAssignments[selectedClient.id].push(torrent);
        clientTorrentCount[selectedClient.id]++;

        // 动态调整效率评分（分配种子后略微降低评分，实现负载均衡）
        const efficiencyPenalty = Math.min(2, +torrent.size / (50 * 1024 * 1024 * 1024)); // 大种子扣分更多，最多扣2分
        clientUploadEfficiency[selectedClient.id] = Math.max(0,
          clientUploadEfficiency[selectedClient.id] - efficiencyPenalty);

        logger.debug(`种子分配: "${torrent.name.substring(0, 30)}..." (${util.formatSize(torrent.size)}) ` +
                    `分配给下载器 ${selectedClient.alias}, ` +
                    `效率评分: ${(clientUploadEfficiency[selectedClient.id] + efficiencyPenalty).toFixed(1)} -> ${clientUploadEfficiency[selectedClient.id].toFixed(1)}`);
      }

      // 输出分配统计信息到日志
      logger.debug(this.alias, '基于综合效率评分的分配结果:');

      // 按分配种子数量排序，便于查看分配情况
      const sortedResults = Object.keys(clientTorrentCount)
        .map(clientId => ({
          clientId,
          client: global.runningClient[clientId],
          torrentCount: clientTorrentCount[clientId],
          finalEfficiency: clientUploadEfficiency[clientId]
        }))
        .sort((a, b) => b.torrentCount - a.torrentCount);

      for (const result of sortedResults) {
        const { client, torrentCount, finalEfficiency } = result;
        const lowerAlias = (client.alias || '').toLowerCase();
        const serverType = lowerAlias.includes('vps') ? 'VPS' : (lowerAlias.includes('hdd') ? 'HDD独服' : '独服');
        const realMaxUploadSpeed = client.maxUploadSpeed ? client.maxUploadSpeed / 10 : 125000000;
        const currentUploadSpeed = client.maindata.uploadSpeed || 0;
        const downloadingCount = client.maindata.leechingCount || 0;
        const utilizationRate = ((currentUploadSpeed / realMaxUploadSpeed) * 100).toFixed(1);

        logger.debug(`下载器: ${client.alias} (${serverType}), ` +
                    `分配种子数: ${torrentCount}, ` +
                    `真实带宽: ${util.formatSize(realMaxUploadSpeed)}/s, ` +
                    `当前上传: ${util.formatSize(currentUploadSpeed)}/s, ` +
                    `下载任务: ${downloadingCount}, ` +
                    `利用率: ${utilizationRate}%, ` +
                    `最终效率评分: ${finalEfficiency.toFixed(1)}`);
      }

      // 输出分配总结
      const totalTorrents = Object.values(clientTorrentCount).reduce((sum, count) => sum + count, 0);
      const vpsCount = sortedResults.filter(r => (r.client.alias || '').toLowerCase().includes('vps')).reduce((sum, r) => sum + r.torrentCount, 0);
      const dedicatedCount = totalTorrents - vpsCount;

      logger.info(this.alias, `种子分配完成: 总计 ${totalTorrents} 个种子, VPS分配 ${vpsCount} 个 (${((vpsCount/totalTorrents)*100).toFixed(1)}%), 独服分配 ${dedicatedCount} 个 (${((dedicatedCount/totalTorrents)*100).toFixed(1)}%)`);

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
    
    // 处理每个下载器的种子分配（并行处理）
    const allProcessingTasks = [];
    const maxConcurrent = 15; // 每个客户端的最大并发处理数量
    
    for (const clientId in clientAssignments) {
      const client = global.runningClient[clientId];
      const clientTorrents = clientAssignments[clientId];
      
      // 对每个下载器的种子进行分批并行处理
      const processBatch = async (torrents) => {
        return Promise.all(torrents.map(async (torrent) => {
          try {
            // 处理种子
            await this._pushTorrent(torrent, client);
          } catch (error) {
            logger.error(this.alias, `处理种子 ${torrent.name} 时出错:`, error);
          }
        }));
      };
      
      // 将客户端的种子分批处理
      for (let i = 0; i < clientTorrents.length; i += maxConcurrent) {
        const batch = clientTorrents.slice(i, i + maxConcurrent);
        allProcessingTasks.push(processBatch(batch));
      }
    }
    
    // 等待所有处理任务完成
    await Promise.all(allProcessingTasks);
    logger.info(this.alias, `RSS任务并行处理完成，共处理 ${newTorrents.length} 个种子`);
    
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
   * 测试Redis缓存机制的正确性
   * @param {string} clientId - 客户端ID
   * @param {string} hash - 种子哈希值
   * @param {number} size - 种子大小
   * @return {Object} 测试结果
   */
  async testCacheMechanism(clientId, hash, size) {
    const results = {
      cacheStatus: { status: 'untested' },
      redisMethods: {
        keys: typeof redis.keys === 'function',
        get: typeof redis.get === 'function',
        set: typeof redis.set === 'function',
        del: typeof redis.del === 'function',
        expire: typeof redis.expire === 'function',
        setWithExpire: typeof redis.setWithExpire === 'function'
      }
    };
    
    // 测试Redis缓存
    try {
      // 创建测试种子对象
      const testTorrent = { hash, size, name: '测试种子' };
      
      // 测试缓存写入
      await this.cacheTorrentToClient(clientId, testTorrent, 60); // 1分钟过期
      results.cacheStatus.write = 'success';
      
      // 测试缓存读取 - 通过hash
      const hashExists = await this.checkTorrentExistsInClient(clientId, testTorrent);
      results.cacheStatus.readByHash = hashExists && hashExists.exists ? 'success' : 'failed';
      
      // 测试缓存读取 - 通过size
      const sizeExists = await redis.get(`vertex:client_torrent:${clientId}:size:${size}`);
      results.cacheStatus.readBySize = sizeExists ? 'success' : 'failed';
      
      // 测试缓存过期时间
      const ttlHash = await redis.ttl(`vertex:client_torrent:${clientId}:hash:${hash}`);
      const ttlSize = await redis.ttl(`vertex:client_torrent:${clientId}:size:${size}`);
      results.cacheStatus.ttlHash = ttlHash;
      results.cacheStatus.ttlSize = ttlSize;
      
      // 测试缓存删除
      await redis.del(`vertex:client_torrent:${clientId}:hash:${hash}`);
      await redis.del(`vertex:client_torrent:${clientId}:size:${size}`);
      const afterDeleteHash = await redis.get(`vertex:client_torrent:${clientId}:hash:${hash}`);
      results.cacheStatus.delete = !afterDeleteHash ? 'success' : 'failed';
      
      results.cacheStatus.status = 'success';
    } catch (e) {
      results.cacheStatus.error = e.message;
      results.cacheStatus.status = 'error';
    }
    
    return results;
  }

  // 调度RSS获取任务
  async scheduleRssFetch() {
    try {
      await this.taskQueue.enqueue({
        rssId: this.id,
        action: 'fetchRss'
      });
    } catch (error) {
      logger.error(`调度RSS任务失败: ${this.alias}`, error);
    }
  }

  // 调度清零计数任务
  async scheduleClearCount() {
    try {
      await this.taskQueue.enqueue({
        rssId: this.id,
        action: 'clearCount'
      });
    } catch (error) {
      logger.error(`调度清零任务失败: ${this.alias}`, error);
    }
  }
}
module.exports = Rss;
