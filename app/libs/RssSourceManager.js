const cron = require('node-cron');

const logger = require('./logger');
const rss = require('./rss');

class RssSourceManager {
  constructor () {
    this.sources = new Map();
  }

  _normalizeUrls (urls) {
    return [...new Set((urls || []).map(url => (url || '').trim()).filter(Boolean))].sort();
  }

  _getScheduleConfig (task) {
    return {
      scheduleType: task.scheduleType,
      cron: task.scheduleType === 'cron' ? task._rss.cron : '',
      intervalSeconds: task.scheduleType === 'interval' ? task.intervalSeconds : 0
    };
  }

  _getSignature (config) {
    return JSON.stringify(config);
  }

  _countConsumers (source) {
    return new Set(Array.from(source.streams.values()).flatMap(stream => Array.from(stream.consumers.keys()))).size;
  }

  register (task) {
    const sourceId = task.sharedSource;
    const scheduleConfig = this._getScheduleConfig(task);
    const signature = this._getSignature(scheduleConfig);
    let source = this.sources.get(sourceId);
    let created = false;

    if (source && source.signature !== signature) {
      throw new Error(`共享 RSS 源 ${sourceId} 的调度配置不一致`);
    }

    if (!source) {
      source = {
        id: sourceId,
        ...scheduleConfig,
        signature,
        streams: new Map(),
        streamOrder: [],
        nextStreamIndex: 0,
        taskUrls: new Map(),
        inFlight: false,
        cronJob: null,
        intervalTimer: null,
        stopped: false
      };
      this.sources.set(sourceId, source);
      created = true;
    }

    const urls = this._normalizeUrls(task.urls);
    source.taskUrls.set(task.id, urls);
    for (const url of urls) {
      let stream = source.streams.get(url);
      if (!stream) {
        stream = { url, consumers: new Map() };
        source.streams.set(url, stream);
        source.streamOrder.push(url);
      }
      stream.consumers.set(task.id, task);
    }

    if (created) {
      this._start(source);
    }
    logger.info('共享 RSS 源', sourceId, `已注册任务 ${task.alias}，当前 ${source.streams.size} 个唯一链接、${this._countConsumers(source)} 个任务`);
  }

  unregister (task) {
    const source = this.sources.get(task.sharedSource);
    if (!source) return;

    const urls = source.taskUrls.get(task.id) || [];
    source.taskUrls.delete(task.id);
    for (const url of urls) {
      const stream = source.streams.get(url);
      if (!stream) continue;
      stream.consumers.delete(task.id);
      if (stream.consumers.size !== 0) continue;
      source.streams.delete(url);
      source.streamOrder = source.streamOrder.filter(item => item !== url);
    }

    if (source.streams.size !== 0) {
      source.nextStreamIndex %= source.streamOrder.length;
      logger.info('共享 RSS 源', source.id, `已移除任务 ${task.alias}，剩余 ${source.streams.size} 个唯一链接、${this._countConsumers(source)} 个任务`);
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
      logger.info('共享 RSS 源', source.id, `已按 ${source.intervalSeconds} 秒全局请求间隔启动`);
      return;
    }

    source.cronJob = cron.schedule(source.cron, () => this._run(source));
    logger.info('共享 RSS 源', source.id, `已按 Cron ${source.cron} 启动，每轮只抓取一个链接`);
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

  _nextStream (source) {
    if (source.streamOrder.length === 0) return null;
    source.nextStreamIndex %= source.streamOrder.length;
    const url = source.streamOrder[source.nextStreamIndex];
    source.nextStreamIndex = (source.nextStreamIndex + 1) % source.streamOrder.length;
    return source.streams.get(url) || null;
  }

  async _fetch (source, stream) {
    const torrents = await rss.getTorrents(stream.url, { throwOnError: true });
    const uniqueTorrents = [];
    const torrentKeys = new Set();
    for (const torrent of torrents) {
      const key = torrent.hash || `${torrent.url || torrent.link || torrent.id || torrent.name}:${torrent.size || 0}`;
      if (torrentKeys.has(key)) continue;
      torrentKeys.add(key);
      uniqueTorrents.push(torrent);
    }
    logger.info('共享 RSS 源', source.id, `链接抓取完成，共 ${uniqueTorrents.length} 个种子`);
    return uniqueTorrents;
  }

  _route (stream, torrents) {
    const consumers = Array.from(stream.consumers.values()).sort((a, b) => {
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

  async _dispatch (source, stream, torrents) {
    const { consumers, batches, unmatched } = this._route(stream, torrents);
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
      logger.info('共享 RSS 源', source.id, `${unmatched} 个种子未匹配当前链接的任何分流任务`);
    }
  }

  async _run (source) {
    if (source.stopped || !this.sources.has(source.id)) return;
    if (source.inFlight) {
      logger.warn('共享 RSS 源', source.id, '上一次抓取仍在运行，跳过本次执行');
      return;
    }

    const stream = this._nextStream(source);
    if (!stream) return;
    source.inFlight = true;
    const startedAt = Date.now();
    try {
      const torrents = await this._fetch(source, stream);
      await this._dispatch(source, stream, torrents);
      logger.info('共享 RSS 源', source.id, `本轮抓取并分流完成，耗时 ${Date.now() - startedAt}ms`);
    } catch (error) {
      logger.error('共享 RSS 源', source.id, '本轮抓取或分流失败', error);
    } finally {
      source.inFlight = false;
    }
  }
}

module.exports = RssSourceManager;
