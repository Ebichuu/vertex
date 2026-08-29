const logger = require('./logger');
const util = require('./util');
const parser = require('./webMonitorParser');

exports.getTorrents = async function (options) {
  const pageUrl = options.pageUrl;
  const res = await util.requestPromise({
    url: pageUrl,
    method: 'GET',
    headers: {
      cookie: options.cookie || ''
    }
  }, false);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`网页请求失败，状态码 ${res.statusCode}`);
  }
  const parserType = options.parserType || 'chd';
  if (parserType === 'chd') return parser.parseChd(res.body, pageUrl, options.cookie || '');
  logger.error('未知网页监控解析器:', parserType);
  throw new Error(`不支持的网页解析器: ${parserType}`);
};
