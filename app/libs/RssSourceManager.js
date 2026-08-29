const cron = require('node-cron');

const logger = require('./logger');
const rss = require('./rss');

class RssSourceManager {
  constructor () {
    this.sources = new Map();
  }

  _normalizeUrls (urls) {
    return (urls || []).map(url => (url || '').trim()).filter(Boolean).sort();
  }

  _getSourceConfig (task) {
    return {
      urls: this._normalizeUrls(task.urls),
      scheduleType: task.scheduleType,
      cron: task.scheduleType === 'cron' ? task._rss.cron : '',
      intervalSeconds: task.scheduleType === 'interval' ? task.intervalSeconds : 0
    };
  }

  _getSignature (config) {
    return JSON.stringify(config);
  }

  register (task) {
    const sourceId = task.sharedSource;
    const config = this._getSourceConfig(task);
    const signature = this._getSignature(config);
    let source = this.sources.get(sourceId);
    let created = false;

    if (source && source.signature !== signature) {
      throw new Error(`共享 RSS 源 ${sourceId} 的链接或调度配置不一致`);
    }

    if (!source) {
      source = {
        id: sourceId,
        ...config,
        signature,
        consumers: new Map(),
        inFlight: false,
        cronJob: null,
        intervalTimer: null,
        stopped: false
      };
      this.sources.set(sourceId, source);
      created = true;
    }

    source.consumers.set(task.id, task);
    if (created) {
      this._start(source);
    }
    logger.info('共享 RSS 源', sourceId, `已注册分流任务 ${task.alias}，当前 ${source.consumers.size} 个任务`);
  }

  unregister (task) {
    const source = this.sources.get(task.sharedSource);
    if (!source) return;

    source.consumers.delete(task.id);
    if (source.consumers.size !== 0) {
      logger.info('共享 RSS 源', source.id, `已移除分流任务 ${task.alias}，剩余 ${source.consumers.size} 个任务`);
      return;
    }

    this._stop(source);
    this.sources.delete(source.id);
    logger.info('共享 RSS 源', source.id, '已停止');
  }

  _start (source) {
    source.stopped = false;
    if (source.scheduleType === 'interval') {
      this._scheduleInterval(source, source.intervalSeconds * 1000);
      logger.info('共享 RSS 源', source.id, `已按 ${source.intervalSeconds} 秒间隔启动`);
      return;
    }

    source.cronJob = cron.schedule(source.cron, () => this._run(source));
    logger.info('共享 RSS 源', source.id, `已按 Cron ${source.cron} 启动`);
  }

  _stop (source) {
    source.stopped = true;
    if (source.cronJob) {
      source.cronJob.stop();
      source.cronJob = null;
    }
    if (source.intervalTimer) {
      clearTimeout(source.intervalTimer);
      source.intervalTimer = null;
    }
  }

  _scheduleInterval (source, delay) {
    if (source.stopped || !this.sources.has(source.id)) return;
    source.intervalTimer = setTimeout(async () => {
      const startedAt = Date.now();
      try {
        await this._run(source);
      } finally {
        const elapsed = Date.now() - startedAt;
        const nextDelay = Math.max(0, source.intervalSeconds * 1000 - elapsed);
        this._scheduleInterval(source, nextDelay);
      }
    }, delay);
  }

  async _fetch (source) {
    const results = await Promise.allSettled(source.urls.map(url => rss.getTorrents(url)));
    const torrents = [];
    let successCount = 0;

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        successCount += 1;
        torrents.push(...result.value);
      } else {
        logger.error('共享 RSS 源', source.id, `第 ${index + 1} 个链接抓取失败`, result.reason);
      }
    }

    if (successCount === 0) {
      throw new Error(`共享 RSS 源 ${source.id} 的所有链接均抓取失败`);
    }

    const uniqueTorrents = [];
    const torrentKeys = new Set();
    for (const torrent of torrents) {
      const key = torrent.hash || `${torrent.url || torrent.link || torrent.id || torrent.name}:${torrent.size || 0}`;
      if (torrentKeys.has(key)) continue;
      torrentKeys.add(key);
      uniqueTorrents.push(torrent);
    }
    return uniqueTorrents;
  }

  _route (source, torrents) {
    const consumers = Array.from(source.consumers.values()).sort((a, b) => {
      if (b.sharedSourcePriority !== a.sharedSourcePriority) {
        return b.sharedSourcePriority - a.sharedSourcePriority;
      }
      return a.id.localeCompare(b.id);
    });
    const batches = new Map(consumers.map(consumer => [consumer.id, []]));
    let unmatched = 0;

    for (const torrent of torrents) {
      const consumer = consumers.find(item => item.matchesSharedTorrent(torrent));
      if (!consumer) {
        unmatched += 1;
        continue;
      }
      batches.get(consumer.id).push(torrent);
    }

    return { consumers, batches, unmatched };
  }

  async _dispatch (source, torrents) {
    const { consumers, batches, unmatched } = this._route(source, torrents);
    const results = await Promise.allSettled(consumers.map(async consumer => {
      const batch = batches.get(consumer.id).map(torrent => ({ ...torrent }));
      await consumer.scheduleRssFetch(batch);
      return { alias: consumer.alias, count: batch.length };
    }));

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        logger.info('共享 RSS 源', source.id, `分流至 ${result.value.alias}: ${result.value.count} 个种子`);
      } else {
        logger.error('共享 RSS 源', source.id, `分流至 ${consumers[index].alias} 失败`, result.reason);
      }
    }
    if (unmatched > 0) {
      logger.info('共享 RSS 源', source.id, `${unmatched} 个种子未匹配任何分流任务`);
    }
  }

  async _run (source) {
    if (source.stopped || !this.sources.has(source.id)) return;
    if (source.inFlight) {
      logger.warn('共享 RSS 源', source.id, '上一次抓取仍在运行，跳过本次执行');
      return;
    }

    source.inFlight = true;
    const startedAt = Date.now();
    try {
      const torrents = await this._fetch(source);
      await this._dispatch(source, torrents);
      logger.info('共享 RSS 源', source.id, `抓取并分流完成，共 ${torrents.length} 个种子，耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      logger.error('共享 RSS 源', source.id, '抓取或分流失败', error);
    } finally {
      source.inFlight = false;
    }
  }
}

module.exports = RssSourceManager;
