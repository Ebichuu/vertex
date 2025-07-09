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

class SettingMod {
  get () {
    const settingStr = fs.readFileSync(settingPath, { encoding: 'utf-8' });
    return { time: moment().unix(), ...JSON.parse(settingStr), password: '' };
  };

  getBackground () {
    return `@vt-bg-image: url('${global.background}');`;
  };

  getCss () {
    const settingStr = fs.readFileSync(settingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr).cssStyle || '';
  };

  modify (_options) {
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

  getTorrentHistorySetting () {
    const settingStr = fs.readFileSync(torrentHistorySettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentHistorySetting (options) {
    fs.writeFileSync(torrentHistorySettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  getTorrentMixSetting () {
    const settingStr = fs.readFileSync(torrentMixSettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentMixSetting (options) {
    fs.writeFileSync(torrentMixSettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  getTorrentPushSetting () {
    const settingStr = fs.readFileSync(torrentPushSettingPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  modifyTorrentPushSetting (options) {
    fs.writeFileSync(torrentPushSettingPath, JSON.stringify(options, null, 2));
    return '修改成功';
  };

  async getRunInfo () {
    const today = moment().format('YYYY-MM-DD');
    const todayStart = moment().startOf('day').unix();
    
    // 获取今日实时统计数据（保持原有逻辑不变）
    const addCountToday = (await util.getRecord('select count(*) as addCount from torrents where record_type = 1 and record_time > ?', [todayStart])).addCount;
    const rejectCountToday = (await util.getRecord('select count(*) as rejectCount from torrents where record_type = 2 and record_time > ?', [todayStart])).rejectCount;
    const deleteCountToday = (await util.getRecord('select count(*) as deleteCount from torrents where delete_time is not null and record_time > ?', [todayStart])).deleteCount;
    
    // 获取今日上传下载数据
    const perTrackerTodaySet = {};
    let uploadedToday = 0;
    let downloadedToday = 0;
    const todayTorrents = await util.getRecords('select a.hash as hash, max(a.upload) - min(a.upload) as upload,  max(a.download) - min(a.download) as download, b.tracker as tracker from torrent_flow a left join torrents b on a.hash = b.hash where a.time >= ? group by a.hash', [todayStart]);
    for (const torrent of todayTorrents) {
      uploadedToday += torrent.upload;
      downloadedToday += torrent.download;
      if (!torrent.tracker) {
        continue;
      }
      if (!perTrackerTodaySet[torrent.tracker]) {
        perTrackerTodaySet[torrent.tracker] = { uploaded: 0, downloaded: 0 };
      }
      perTrackerTodaySet[torrent.tracker].uploaded += torrent.upload;
      perTrackerTodaySet[torrent.tracker].downloaded += torrent.download;
    }
    const perTrackerToday = [];
    for (const tracker of Object.keys(perTrackerTodaySet)) {
      perTrackerToday.push({ tracker, ...perTrackerTodaySet[tracker] });
    }
    
    // 获取今日种子上传下载总量（来自torrents表）
    const todayTorrentsStats = await util.getRecord('select sum(upload) as uploaded, sum(download) as downloaded from torrents where record_time >= ?', [todayStart]);
    const todayUploadFromTorrents = todayTorrentsStats.uploaded || 0;
    const todayDownloadFromTorrents = todayTorrentsStats.downloaded || 0;
    
    // 获取今日tracker统计（来自torrents表）
    const todayPerTrackerFromTorrents = await util.getRecords('select sum(upload) as uploaded, sum(download) as downloaded, tracker from torrents where tracker is not null and record_time >= ? group by tracker', [todayStart]);
    
    // 获取历史聚合数据（昨天及之前）
    const historicalStats = await util.getRecord('select sum(total_uploaded) as historicalUploaded, sum(total_downloaded) as historicalDownloaded, sum(add_count) as historicalAddCount, sum(reject_count) as historicalRejectCount, sum(delete_count) as historicalDeleteCount from daily_stats where stats_date < ?', [today]);
    
    // 获取历史tracker聚合数据
    const historicalPerTrackerData = await util.getRecords('select per_tracker_stats from daily_stats where stats_date < ? and per_tracker_stats is not null', [today]);
    const historicalPerTrackerSet = {};
    for (const record of historicalPerTrackerData) {
      try {
        const trackerStats = JSON.parse(record.per_tracker_stats);
        for (const stat of trackerStats) {
          if (!stat.tracker) continue;
          if (!historicalPerTrackerSet[stat.tracker]) {
            historicalPerTrackerSet[stat.tracker] = { uploaded: 0, downloaded: 0 };
          }
          historicalPerTrackerSet[stat.tracker].uploaded += stat.uploaded || 0;
          historicalPerTrackerSet[stat.tracker].downloaded += stat.downloaded || 0;
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
    
    // 合并历史数据和今日数据
    const uploaded = (historicalStats.historicalUploaded || 0) + todayUploadFromTorrents;
    const downloaded = (historicalStats.historicalDownloaded || 0) + todayDownloadFromTorrents;
    const addCount = (historicalStats.historicalAddCount || 0) + addCountToday;
    const rejectCount = (historicalStats.historicalRejectCount || 0) + rejectCountToday;
    const deleteCount = (historicalStats.historicalDeleteCount || 0) + deleteCountToday;
    
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
    
    const perTracker = [];
    for (const tracker of Object.keys(perTrackerSet)) {
      perTracker.push({ tracker, ...perTrackerSet[tracker] });
    }
    
    const errors = global.ignoreError ? [] : JSON.parse(await redis.get('vertex:error:list') || '[]');
    await redis.set('vertex:error:list', '[]');
    
    return {
      dashboardContent: global.dashboardContent,
      uploaded: uploaded || 0,
      downloaded: downloaded || 0,
      uploadedToday: uploadedToday || 0,
      downloadedToday: downloadedToday || 0,
      addCount,
      rejectCount,
      deleteCount,
      addCountToday,
      rejectCountToday,
      deleteCountToday,
      startTime: global.startTime,
      perTracker,
      perTrackerToday,
      errors
    };
  };

  async backupVertex (options) {
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

  async restoreVertex (options) {
    const backupsFile = options.file.path || options.file.originalFilename;
    await util.tar.x({
      gzip: true,
      file: backupsFile,
      C: '/tmp'
    });
    return '数据导入成功, 重启容器后生效。';
  }

  async networkTest (options) {
    return await util.requestPromise({
      url: options.address,
      headers: {
        cookie: options.cookie
      }
    });
  }

  async getTrackerFlowHistory () {
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

  getHosts () {
    const hosts = fs.readFileSync('/etc/hosts', { encoding: 'utf-8' });
    return hosts;
  };

  save (options) {
    fs.writeFileSync('/etc/hosts', options.hosts);
    fs.copyFileSync('/etc/hosts', path.join(__dirname, '../data/hosts'));
    return '保存成功';
  };

  import () {
    fs.copyFileSync(path.join(__dirname, '../data/hosts'), '/etc/hosts');
    return '导入成功';
  };

  export () {
    fs.copyFileSync('/etc/hosts', path.join(__dirname, '../data/hosts'));
    return '导出成功';
  };

  getProxy () {
    const settingStr = fs.readFileSync(proxyPath, { encoding: 'utf-8' });
    return JSON.parse(settingStr);
  };

  saveProxy (options) {
    fs.writeFileSync(proxyPath, JSON.stringify({ proxy: options.proxy || '', domains: options.domains || '' }, null, 2));
    global.proxy = options.proxy || '';
    global.domains = options.domains || '';
    return '保存成功';
  };

  async clearHistory () {
    await util.runRecord('delete from sites;');
    await util.runRecord('delete from torrent_flow;');
    await util.runRecord('delete from torrents;');
    await util.runRecord('delete from tracker_flow;');
    await util.runRecord('delete from vnstat;');
    return '删除成功';
  };
}

module.exports = SettingMod;
