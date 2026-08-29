const fs = require('fs');
const path = require('path');

const WebMonitor = require('../common/WebMonitor');
const util = require('../libs/util');

class WebMonitorMod {
  _normalize (options) {
    const monitor = { ...options };
    delete monitor.status;
    monitor.alias = (monitor.alias || '').trim();
    monitor.pageUrl = (monitor.pageUrl || '').trim();
    monitor.cookie = (monitor.cookie || '').trim();
    monitor.parserType = monitor.parserType || 'chd';
    monitor.targetSharedSource = (monitor.targetSharedSource || '').trim();
    monitor.minIntervalSeconds = Math.floor(Number(monitor.minIntervalSeconds) || 11);
    monitor.maxIntervalSeconds = Math.floor(Number(monitor.maxIntervalSeconds) || 61);
    return monitor;
  }

  _validate (monitor) {
    if (!monitor.alias) throw new Error('网页监控别名不能为空');
    try {
      const pageUrl = new URL(monitor.pageUrl);
      if (!['http:', 'https:'].includes(pageUrl.protocol)) throw new Error('invalid protocol');
    } catch (e) {
      throw new Error('网页地址无效');
    }
    if (!monitor.cookie) throw new Error('网页监控 Cookie 不能为空');
    if (monitor.parserType !== 'chd') throw new Error('目前仅支持 CHD 网页解析器');
    if (!monitor.targetSharedSource) throw new Error('目标共享源不能为空');
    if (!Number.isInteger(monitor.minIntervalSeconds) || monitor.minIntervalSeconds < 1 || monitor.minIntervalSeconds > 86400) {
      throw new Error('最短间隔必须是 1 到 86400 之间的整数');
    }
    if (!Number.isInteger(monitor.maxIntervalSeconds) || monitor.maxIntervalSeconds < monitor.minIntervalSeconds || monitor.maxIntervalSeconds > 86400) {
      throw new Error('最长间隔必须大于等于最短间隔，且不能超过 86400 秒');
    }
  }

  _directory () {
    const directory = path.join(__dirname, '../data/webMonitor');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  add (options) {
    const monitor = this._normalize(options);
    monitor.id = util.uuid.v4().split('-')[0];
    this._validate(monitor);
    fs.writeFileSync(path.join(this._directory(), monitor.id + '.json'), JSON.stringify(monitor, null, 2));
    if (monitor.enable) global.runningWebMonitor[monitor.id] = new WebMonitor(monitor);
    return '添加网页监控成功';
  }

  modify (options) {
    const monitor = this._normalize(options);
    if (!monitor.id) throw new Error('网页监控 ID 不能为空');
    this._validate(monitor);
    fs.writeFileSync(path.join(this._directory(), monitor.id + '.json'), JSON.stringify(monitor, null, 2));
    if (global.runningWebMonitor[monitor.id]) global.runningWebMonitor[monitor.id].destroy();
    if (monitor.enable) global.runningWebMonitor[monitor.id] = new WebMonitor(monitor);
    return '修改网页监控成功';
  }

  delete (options) {
    if (global.runningWebMonitor[options.id]) global.runningWebMonitor[options.id].destroy();
    fs.unlinkSync(path.join(this._directory(), options.id + '.json'));
    return '删除网页监控成功';
  }

  list () {
    return util.listWebMonitor().map(item => {
      const running = global.runningWebMonitor[item.id];
      return {
        ...item,
        status: running
          ? running.status()
          : {
            running: false,
            inFlight: false,
            lastCheckTime: 0,
            lastSuccessTime: 0,
            lastFoundTime: 0,
            lastError: ''
          }
      };
    });
  }
}

module.exports = WebMonitorMod;
