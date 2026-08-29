const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const Rss = require('../common/Rss');

const util = require('../libs/util');
class RssMod {
  _normalizeRssSet (options) {
    const rssSet = { ...options };
    rssSet.downloadUrlReplaceRules = this._normalizeDownloadUrlReplaceRules(rssSet.downloadUrlReplaceRules);
    rssSet.rssUrls = (rssSet.rssUrls || []).map(url => (url || '').trim()).filter(Boolean);
    rssSet.scheduleType = rssSet.scheduleType === 'interval' ? 'interval' : 'cron';
    rssSet.intervalSeconds = Math.floor(Number(rssSet.intervalSeconds) || 60);
    rssSet.sharedSource = (rssSet.sharedSource || '').trim();
    rssSet.sharedSourcePriority = Number(rssSet.sharedSourcePriority) || 0;
    return rssSet;
  }

  _getSharedSourceSignature (rssSet) {
    return JSON.stringify({
      urls: [...rssSet.rssUrls].sort(),
      scheduleType: rssSet.scheduleType,
      cron: rssSet.scheduleType === 'cron' ? rssSet.cron : '',
      intervalSeconds: rssSet.scheduleType === 'interval' ? rssSet.intervalSeconds : 0
    });
  }

  _validateRssSet (rssSet) {
    if (rssSet.rssUrls.length === 0) {
      throw new Error('至少需要填写一个 RSS 链接');
    }
    if (rssSet.scheduleType === 'interval') {
      if (!Number.isInteger(rssSet.intervalSeconds) || rssSet.intervalSeconds < 1 || rssSet.intervalSeconds > 86400) {
        throw new Error('RSS 间隔秒数必须是 1 到 86400 之间的整数');
      }
    } else if (!rssSet.cron || !cron.validate(rssSet.cron)) {
      throw new Error('RSS Cron 表达式无效');
    }

    if (!rssSet.enable || !rssSet.sharedSource) return;
    const signature = this._getSharedSourceSignature(rssSet);
    const conflict = util.listRss().find(item => {
      if (!item.enable || item.id === rssSet.id || (item.sharedSource || '').trim() !== rssSet.sharedSource) return false;
      return this._getSharedSourceSignature(this._normalizeRssSet(item)) !== signature;
    });
    if (conflict) {
      throw new Error(`共享 RSS 源 ${rssSet.sharedSource} 与任务 ${conflict.alias} 的链接或调度配置不一致`);
    }
  }

  _normalizeDownloadUrlReplaceRules (rules) {
    return (rules || [])
      .map(rule => ({ from: (rule.from || '').trim(), to: (rule.to || '').trim() }))
      .filter(rule => rule.from && rule.to);
  }

  add (options) {
    const id = util.uuid.v4().split('-')[0];
    const rssSet = this._normalizeRssSet(options);
    rssSet.id = id;
    this._validateRssSet(rssSet);
    fs.writeFileSync(path.join(__dirname, '../data/rss/', id + '.json'), JSON.stringify(rssSet, null, 2));
    if (global.runningRss[id]) global.runningRss[id].destroy();
    if (rssSet.enable) global.runningRss[id] = new Rss(rssSet);
    return '添加 Rss 成功';
  };

  delete (options) {
    fs.unlinkSync(path.join(__dirname, '../data/rss/', options.id + '.json'));
    if (global.runningRss[options.id]) global.runningRss[options.id].destroy();
    return '删除 Rss 成功';
  };

  async deleteRecord (options) {
    await util.runRecord('delete from torrents where id = ?', [options.id]);
    return '删除 Rss 记录成功';
  };

  modify (options) {
    const rssSet = this._normalizeRssSet(options);
    rssSet.sameServerClients = rssSet.sameServerClients || [];
    rssSet.reseedClients = rssSet.reseedClients || [];
    this._validateRssSet(rssSet);
    fs.writeFileSync(path.join(__dirname, '../data/rss/', options.id + '.json'), JSON.stringify(rssSet, null, 2));
    if (global.runningRss[options.id]) global.runningRss[options.id].destroy();
    if (rssSet.enable) global.runningRss[options.id] = new Rss(rssSet);
    return '修改 Rss 成功';
  };

  list () {
    const rssList = util.listRss();
    for (const rss of rssList) {
      if (rss.client) {
        rss.clientArr = [rss.client];
        delete rss.client;
      }
      rss.acceptRules = rss.acceptRules || [];
      rss.rejectRules = rss.rejectRules || [];
      rss.downloadUrlReplaceRules = rss.downloadUrlReplaceRules || [];
      rss.scheduleType = rss.scheduleType === 'interval' ? 'interval' : 'cron';
      rss.intervalSeconds = Math.floor(Number(rss.intervalSeconds) || 60);
      rss.sharedSource = rss.sharedSource || '';
      rss.sharedSourcePriority = Number(rss.sharedSourcePriority) || 0;
    }
    return rssList;
  };

  async dryrun (options) {
    const id = util.uuid.v4().split('-')[0];
    const rssSet = this._normalizeRssSet(options);
    rssSet.id = id;
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    const torrents = await rss.dryrun();
    return torrents;
  };

  async mikanSearch (options) {
    const rssList = util.listRss();
    const rssSet = rssList.filter(item => item.id === options.rss)[0];
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    const torrents = await rss.mikanSearch(options.name);
    return torrents;
  };

  async mikanPush (options) {
    const rssList = util.listRss();
    const rssSet = rssList.filter(item => item.id === options.rss)[0];
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    rss.rss(options.torrents);
    return '任务已开始执行。';
  };
}

module.exports = RssMod;
