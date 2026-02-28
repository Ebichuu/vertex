const fs = require('fs');
const path = require('path');
const moment = require('moment');
const util = require('../libs/util');
const redis = require('../libs/redis');
const Push = require('../common/Push');
const otp = require('../libs/otp');

const settingPath = path.join(__dirname, '../data/setting.json');
const proxyPath = path.join(__dirname, '../data/setting/proxy.json');
const torrentHistorySettingPath = path.join(__dirname, '../data/setting/torrent-history-setting.json');
const torrentMixSettingPath = path.join(__dirname, '../data/setting/torrent-mix-setting.json');
const torrentPushSettingPath = path.join(__dirname, '../data/setting/torrent-push-setting.json');

// 🚀 性能优化：添加查询缓存
class QueryCache {
  constructor() {
    this.cache = new Map();
    this.TTL = 30000; // 30秒缓存时间
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.TTL) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // 清理过期缓存
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now - v.timestamp > this.TTL) {
          this.cache.delete(k);
        }
      }
    }
  }

  clear() {
    this.cache.clear();
  }
}

const queryCache = new QueryCache();

class SettingMod {
  get() {
    const settingStr = fs.readFileSync(settingPath, { encoding: 'utf-8' });
    return { time: moment().unix(), ...JSON.parse(settingStr), password: '' };
  };

  getBackground() {
    return `@vt-bg-image: url('${global.background}');`;
  };

  getCss() {
    const settingStr = fs.readFileSync(settingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr).cssStyle || '';
  };

  modify(_options) {
    if (_options.password === '') {
      delete _options.password;
    }
    if (_options.otp && _options.otpPw && _options.otp !== '******') {
      if (otp.verify(_options.otp, _options.otpPw)) {
        global.auth.otp = _options.otp;
      } else {
        throw new Error('二步验证码错误');
      }
    } else {
      delete _options.otp;
    }
    delete _options.otpPw;
    delete _options.time;
    const options = Object.assign(JSON.parse(fs.readFileSync(settingPath, { encoding: 'utf-8' })), _options);
    options.apiKey = options.apiKey || util.uuid.v4().replace(/-/g, '').toUpperCase();
    fs.writeFileSync(settingPath, JSON.stringify(options, null, 2));
    global.auth = {
      username: options.username,
      password: options.password,
      otp: global.auth.otp
    };
    global.webhookPushTo = options.webhookPushTo;
    global.menu = options.menu || [];
    global.dashboardContent = options.dashboardContent || [];
    global.dashboardRefreshInterval = options.dashboardRefreshInterval || 5;
    global.userAgent = options.userAgent;
    global.ignoreError = options.ignoreError;
    global.ignoreDependCheck = options.ignoreDependCheck;
    global.apiKey = options.apiKey;
    global.trustVertexPanel = options.trustVertexPanel;
    global.theme = options.theme;
    global.siteInfo = options.siteInfo;
    global.trustAllCerts = options.trustAllCerts;
    global.background = options.background;
    global.tmdbApiKey = options.tmdbApiKey;
    global.dataPath = options.dataPath || '/';
    global.wechatCover = options.wechatCover;
    global.embyCover = options.embyCover;
    global.plexCover = options.plexCover;
    global.wechatToken = options.wechatToken;
    global.wechatAesKey = options.wechatAesKey;
    global.doubanPush = options.doubanPush;
    global.panelKey = options.panelKey;
    global.telegramProxy = options.telegramProxy || 'https://api.telegram.org';
    global.wechatProxy = options.wechatProxy;
    const webhookPush = util.listPush().filter(item => item.id === global.webhookPushTo)[0];
    if (webhookPush) {
      global.webhookPush = new Push({ ...webhookPush, push: true });
    }
    const doubanPush = util.listPush().filter(item => item.id === global.doubanPush)[0];
    if (doubanPush) {
      global.doubanPush = new Push({ ...doubanPush, push: true });
      global.doubanPush.modifyWechatMenu();
    }
    // cookiecloud
    util.initCookieCloud();
    return '修改全局设置成功, 部分设定需要刷新页面生效';
  };

  getTorrentHistorySetting() {
    const settingStr = fs.readFileSync(torrentHistorySettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentHistorySetting(options) {
    fs.writeFileSync(torrentHistorySettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  getTorrentMixSetting() {
    const settingStr = fs.readFileSync(torrentMixSettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentMixSetting(options) {
    fs.writeFileSync(torrentMixSettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  getTorrentPushSetting() {
    const settingStr = fs.readFileSync(torrentPushSettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentPushSetting(options) {
    fs.writeFileSync(torrentPushSettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  async getRunInfo() {
    // 🚀 性能优化：检查缓存
    const cacheKey = 'runInfo';
    const cached = queryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 获取中国时区的moment对象
    const getMomentCN = (input) => {
      if (input) {
        return moment(input).utcOffset(8 * 60); // UTC+8
      }
      return moment().utcOffset(8 * 60); // UTC+8
    };

    const today = getMomentCN().format('YYYY-MM-DD');
    const todayStart = getMomentCN().startOf('day').unix();

    // 🚀 性能优化：并行执行基础统计查询
    const [
      addCountToday,
      rejectCountToday,
      deleteCountToday,
      todayTorrentsStats,
      todayPerTrackerFromTorrents,
      historicalStats
    ] = await Promise.all([
      util.getRecord('select count(*) as addCount from torrents where record_type = 1 and record_time >= ?', [todayStart]),
      util.getRecord('select count(*) as rejectCount from torrents where record_type = 2 and record_time >= ?', [todayStart]),
      util.getRecord('select count(*) as deleteCount from torrents where delete_time is not null and delete_time >= ?', [todayStart]),
      util.getRecord('select sum(upload) as uploaded, sum(download) as downloaded from torrents where record_time >= ?', [todayStart]),
      util.getRecords('select sum(upload) as uploaded, sum(download) as downloaded, tracker from torrents where tracker is not null and record_time >= ? group by tracker', [todayStart]),
      util.getRecord('select sum(total_uploaded) as historicalUploaded, sum(total_downloaded) as historicalDownloaded, sum(add_count) as historicalAddCount, sum(reject_count) as historicalRejectCount, sum(delete_count) as historicalDeleteCount from daily_stats where stats_date < ?', [today])
    ]);

    // 🚀 性能优化：简化今日上传下载数据获取
    // 不再使用复杂的 torrent_flow JOIN 查询，直接使用 torrents 表数据
    const todayUploadFromTorrents = todayTorrentsStats.uploaded || 0;
    const todayDownloadFromTorrents = todayTorrentsStats.downloaded || 0;

    // 🚀 性能优化：使用优化的方法获取今日流量数据（基于torrent_flow，但仅在需要时）
    let uploadedToday = 0;
    let downloadedToday = 0;
    const perTrackerTodaySet = {};

    try {
      // 使用优化的查询：先获取今日有数据的hash列表，再分批处理
      const todayHashesResult = await util.getRecord('select count(distinct hash) as hashCount from torrent_flow where time >= ?', [todayStart]);

      if (todayHashesResult.hashCount > 0 && todayHashesResult.hashCount < 10000) {
        // 只有在数据量合理的情况下才执行复杂查询
        const todayTorrents = await util.getRecords(
          `select tf.hash, 
                  max(tf.upload) - min(tf.upload) as upload,
                  max(tf.download) - min(tf.download) as download, 
                  t.tracker
           from torrent_flow tf 
           left join torrents t on tf.hash = t.hash 
           where tf.time >= ? 
           group by tf.hash 
           limit 5000`,
          [todayStart]
        );

        for (const torrent of todayTorrents) {
          uploadedToday += torrent.upload || 0;
          downloadedToday += torrent.download || 0;
          if (torrent.tracker) {
            if (!perTrackerTodaySet[torrent.tracker]) {
              perTrackerTodaySet[torrent.tracker] = { uploaded: 0, downloaded: 0 };
            }
            perTrackerTodaySet[torrent.tracker].uploaded += torrent.upload || 0;
            perTrackerTodaySet[torrent.tracker].downloaded += torrent.download || 0;
          }
        }
      } else {
        // 数据量过大时，使用简化的统计方法
        console.log('⚠️ 今日种子数据量较大，使用简化统计方法');
        uploadedToday = todayUploadFromTorrents;
        downloadedToday = todayDownloadFromTorrents;

        // 使用 torrents 表的今日tracker统计作为替代
        for (const stat of todayPerTrackerFromTorrents) {
          if (stat.tracker) {
            perTrackerTodaySet[stat.tracker] = {
              uploaded: stat.uploaded || 0,
              downloaded: stat.downloaded || 0
            };
          }
        }
      }
    } catch (e) {
      console.warn('🔧 torrent_flow查询失败，使用备用统计方法:', e.message);
      uploadedToday = todayUploadFromTorrents;
      downloadedToday = todayDownloadFromTorrents;

      for (const stat of todayPerTrackerFromTorrents) {
        if (stat.tracker) {
          perTrackerTodaySet[stat.tracker] = {
            uploaded: stat.uploaded || 0,
            downloaded: stat.downloaded || 0
          };
        }
      }
    }

    const perTrackerToday = Object.keys(perTrackerTodaySet).map(tracker =>
      ({ tracker, ...perTrackerTodaySet[tracker] })
    );

    // 🚀 性能优化：异步获取历史tracker数据，不阻塞主流程
    const historicalPerTrackerSet = {};
    const historicalPerTrackerData = await util.getRecords('select per_tracker_stats from daily_stats where stats_date < ? and per_tracker_stats is not null and per_tracker_stats != \'[]\' limit 100', [today]);

    for (const record of historicalPerTrackerData) {
      try {
        const trackerStats = JSON.parse(record.per_tracker_stats);
        if (Array.isArray(trackerStats)) {
          for (const stat of trackerStats) {
            if (!stat.tracker) continue;
            if (!historicalPerTrackerSet[stat.tracker]) {
              historicalPerTrackerSet[stat.tracker] = { uploaded: 0, downloaded: 0 };
            }
            historicalPerTrackerSet[stat.tracker].uploaded += stat.uploaded || 0;
            historicalPerTrackerSet[stat.tracker].downloaded += stat.downloaded || 0;
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }

    // 合并历史数据和今日数据
    const uploaded = (historicalStats.historicalUploaded || 0) + todayUploadFromTorrents;
    const downloaded = (historicalStats.historicalDownloaded || 0) + todayDownloadFromTorrents;
    const addCount = (historicalStats.historicalAddCount || 0) + addCountToday.addCount;
    const rejectCount = (historicalStats.historicalRejectCount || 0) + rejectCountToday.rejectCount;
    const deleteCount = (historicalStats.historicalDeleteCount || 0) + deleteCountToday.deleteCount;

    // 合并tracker统计
    const perTrackerSet = { ...historicalPerTrackerSet };
    for (const stat of todayPerTrackerFromTorrents) {
      if (!stat.tracker) continue;
      if (!perTrackerSet[stat.tracker]) {
        perTrackerSet[stat.tracker] = { uploaded: 0, downloaded: 0 };
      }
      perTrackerSet[stat.tracker].uploaded += stat.uploaded || 0;
      perTrackerSet[stat.tracker].downloaded += stat.downloaded || 0;
    }

    const perTracker = Object.keys(perTrackerSet).map(tracker =>
      ({ tracker, ...perTrackerSet[tracker] })
    );

    const errors = global.ignoreError ? [] : JSON.parse(await redis.get('vertex:error:list') || '[]');
    await redis.set('vertex:error:list', '[]');

    const result = {
      dashboardContent: global.dashboardContent,
      dashboardRefreshInterval: global.dashboardRefreshInterval || 5,
      uploaded: uploaded || 0,
      downloaded: downloaded || 0,
      uploadedToday: uploadedToday || 0,
      downloadedToday: downloadedToday || 0,
      addCount,
      rejectCount,
      deleteCount,
      addCountToday: addCountToday.addCount,
      rejectCountToday: rejectCountToday.rejectCount,
      deleteCountToday: deleteCountToday.deleteCount,
      startTime: global.startTime,
      perTracker,
      perTrackerToday,
      errors
    };

    // 🚀 性能优化：将结果存储到缓存
    queryCache.set(cacheKey, result);

    return result;
  };

  async backupVertex(options) {
    const backupsFile = `/tmp/Vertex-backups-${moment().format('YYYY-MM-DD_HH:mm:ss')}.tar.gz`;
    const backupsFileds = ['vertex/db', 'vertex/data', 'vertex/config'];
    if (options.bt + '' === 'true') {
      backupsFileds.push('vertex/torrents');
    }
    await util.tar.c({
      gzip: true,
      file: backupsFile,
      cwd: global.dataPath
    }, backupsFileds);
    return backupsFile;
  }

  async restoreVertex(options) {
    const backupsFile = options.file.path || options.file.originalFilename;
    await util.tar.x({
      gzip: true,
      file: backupsFile,
      C: '/tmp'
    });
    return '数据导入成功, 重启容器后生效。';
  }

  async networkTest(options) {
    return await util.requestPromise({
      url: options.address,
      headers: {
        cookie: options.cookie
      }
    });
  }

  async getTrackerFlowHistory() {
    const _timeGroup = await util.getRecords('select time from tracker_flow where time >= ? group by time', [moment().unix() - 24 * 3600]);
    const timeGroup = _timeGroup.map(i => i.time);
    const res = await util.getRecords('select * from tracker_flow where time >= ?', [moment().unix() - 24 * 3600]);
    const trackers = {};
    for (const item of res) {
      if (!item.tracker) continue;
      if (!trackers[item.tracker]) trackers[item.tracker] = {};
      trackers[item.tracker][item.time] = item;
    }
    for (const _tracker of Object.keys(trackers)) {
      const tracker = trackers[_tracker];
      for (const [index, time] of timeGroup.entries()) {
        const _t = tracker[time] || tracker[timeGroup[index - 1]] || { download: 0, upload: 0 };
        tracker[time] = { download: +(_t.download / 300).toFixed(2), upload: +(_t.upload / 300).toFixed(2) };
      }
    }
    return {
      trackers,
      timeGroup
    };
  }

  getHosts() {
    const hosts = fs.readFileSync('/etc/hosts', { encoding: 'utf-8' });
    return hosts;
  };

  save(options) {
    fs.writeFileSync('/etc/hosts', options.hosts);
    fs.copyFileSync('/etc/hosts', path.join(__dirname, '../data/hosts'));
    return '保存成功';
  };

  import() {
    fs.copyFileSync(path.join(__dirname, '../data/hosts'), '/etc/hosts');
    return '导入成功';
  };

  export() {
    fs.copyFileSync('/etc/hosts', path.join(__dirname, '../data/hosts'));
    return '导出成功';
  };

  getProxy() {
    const settingStr = fs.readFileSync(proxyPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  saveProxy(options) {
    fs.writeFileSync(proxyPath, JSON.stringify({ proxy: options.proxy || '', domains: options.domains || '' }, null, 2));
    global.proxy = options.proxy || '';
    global.domains = options.domains || '';
    return '保存成功';
  };

  async clearHistory() {
    await util.runRecord('delete from sites;');
    await util.runRecord('delete from torrent_flow;');
    await util.runRecord('delete from torrents;');
    await util.runRecord('delete from tracker_flow;');
    await util.runRecord('delete from vnstat;');
    await util.runRecord('delete from daily_stats;');
    return '删除成功';
  };
}

module.exports = SettingMod;
