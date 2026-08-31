const bencode = require('bencode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

exports.enrichTorrents = async function (torrents, options) {
  const parserType = options.parserType || 'chd';
  if (parserType !== 'chd') return torrents;

  return await Promise.all(torrents.map(async torrent => {
    try {
      const res = await util.requestPromise({
        url: torrent.url,
        method: 'GET',
        encoding: null,
        headers: {
          cookie: options.cookie || '',
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      }, false);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`状态码 ${res.statusCode}`);
      }
      const buffer = Buffer.from(res.body);
      if (buffer[0] !== 100) throw new Error('响应不是有效的种子文件');
      const metadata = bencode.decode(buffer);
      if (!metadata.info) throw new Error('种子文件缺少 info 元数据');
      const hash = crypto.createHash('sha1').update(bencode.encode(metadata.info)).digest('hex');
      const nameBuffer = metadata.info['name.utf-8'] || metadata.info.name;
      const name = nameBuffer && nameBuffer.toString();
      const size = metadata.info.length || (metadata.info.files || []).reduce((sum, file) => sum + file.length, 0);
      if (!name || !size) throw new Error('种子文件缺少完整标题或大小');

      const filepath = path.join(__dirname, '../../torrents', hash + '.torrent');
      fs.writeFileSync(filepath, buffer);
      return {
        ...torrent,
        hash,
        name,
        size
      };
    } catch (error) {
      throw new Error(`种子 ${torrent.sourceKey || torrent.id || 'unknown'} 元数据读取失败: ${error.message}`);
    }
  }));
};
