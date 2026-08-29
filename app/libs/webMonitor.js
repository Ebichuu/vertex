const logger = require('./logger');
const util = require('./util');
const parser = require('./webMonitorParser');

exports.getTorrents = async function (options) {
  const parserType = options.parserType || 'chd';
  const pageUrls = parserType === 'chd'
    ? parser.buildChdPageUrls(options.pageUrl, options.pageCount)
    : [options.pageUrl];
  const torrents = [];
  const failures = [];

  for (const pageUrl of pageUrls) {
    try {
      const res = await util.requestPromise({
        url: pageUrl,
        method: 'GET',
        headers: {
          cookie: options.cookie || '',
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      }, false);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`状态码 ${res.statusCode}`);
      }
      if (parserType === 'chd') {
        torrents.push(...parser.parseChd(res.body, pageUrl, options.cookie || ''));
      } else {
        throw new Error(`不支持的网页监控解析器: ${parserType}`);
      }
    } catch (error) {
      failures.push({ pageUrl, error });
      logger.error('网页监控页面读取失败:', pageUrl, error);
    }
  }

  if (failures.length > 0) {
    throw new Error(`网页监控有 ${failures.length}/${pageUrls.length} 个页面读取失败`);
  }

  const unique = new Map();
  for (const torrent of torrents) {
    const key = torrent.sourceKey || torrent.hash || torrent.url || torrent.link;
    if (key && !unique.has(key)) unique.set(key, torrent);
  }
  return Array.from(unique.values());
};
