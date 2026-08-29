const logger = require('../libs/logger');
const webMonitor = require('../libs/webMonitor');

class WebMonitor {
  constructor (options) {
    this.options = options;
    this.id = options.id;
    this.alias = options.alias;
    this.targetSharedSource = options.targetSharedSource;
    this.minIntervalSeconds = Number(options.minIntervalSeconds);
    this.maxIntervalSeconds = Number(options.maxIntervalSeconds);
    this.timer = null;
    this.inFlight = false;
    this.destroyed = false;
    this.lastCheckTime = 0;
    this.lastSuccessTime = 0;
    this.lastFoundTime = 0;
    this.lastError = '';
    this._scheduleNext();
    logger.info('网页监控', this.alias, `已启动，随机间隔 ${this.minIntervalSeconds}-${this.maxIntervalSeconds} 秒`);
  }

  _nextDelay () {
    const range = this.maxIntervalSeconds - this.minIntervalSeconds + 1;
    return (this.minIntervalSeconds + Math.floor(Math.random() * range)) * 1000;
  }

  _scheduleNext () {
    if (this.destroyed) return;
    this.timer = setTimeout(async () => {
      try {
        await this.run();
      } finally {
        this._scheduleNext();
      }
    }, this._nextDelay());
  }

  async run () {
    if (this.destroyed || this.inFlight) return;
    this.inFlight = true;
    this.lastCheckTime = Math.floor(Date.now() / 1000);
    const startedAt = Date.now();
    try {
      if (!global.rssSourceManager) {
        throw new Error('没有正在运行的共享 RSS 分流源');
      }
      const torrents = await webMonitor.getTorrents(this.options);
      await global.rssSourceManager.dispatchExternal(this.targetSharedSource, torrents, '网页监控');
      this.lastSuccessTime = Math.floor(Date.now() / 1000);
      if (torrents.length > 0) this.lastFoundTime = this.lastSuccessTime;
      this.lastError = '';
      logger.info('网页监控', this.alias, `发现 ${torrents.length} 个页面种子并交给共享分流，耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      this.lastError = error.message;
      logger.error('网页监控', this.alias, '执行失败:', error);
    } finally {
      this.inFlight = false;
    }
  }

  status () {
    return {
      running: !this.destroyed,
      inFlight: this.inFlight,
      lastCheckTime: this.lastCheckTime,
      lastSuccessTime: this.lastSuccessTime,
      lastFoundTime: this.lastFoundTime,
      lastError: this.lastError
    };
  }

  destroy () {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    delete global.runningWebMonitor[this.id];
    logger.info('网页监控', this.alias, '已停止');
  }
}

module.exports = WebMonitor;
