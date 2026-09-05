const crypto = require('crypto');
const moment = require('moment');
const { JSDOM } = require('jsdom');

const torrentIdentity = require('./torrentIdentity');

const chdOfficialTitlePattern = /(?:-(?:CHD|CHDBits|CHDWEB|CHDTV|CHDPAD|CHDHKTV|SGNB|OneHD|blucook|KAN|JKCT|BMDru|Destiny|SP)|@CHDBits)(?:\s|$)/i;
const chdRevivalFreeSeconds = 7 * 24 * 60 * 60;

const parseChdTime = function (value) {
  const parsed = moment.parseZone(`${value} +08:00`, 'YYYY-MM-DD HH:mm:ss Z', true);
  return parsed.isValid() ? parsed.unix() : 0;
};

const parseSizeText = function (sizeText) {
  const match = (sizeText || '').replace(/\u00a0/g, ' ').match(/(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i);
  if (!match) return 0;
  const unitMap = {
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4
  };
  return parseFloat(match[1]) * unitMap[match[2].toLowerCase()];
};

exports.buildChdPageUrls = function (pageUrl, pageCount = 2) {
  const url = new URL(pageUrl);
  const count = Math.max(1, Math.min(5, Math.floor(Number(pageCount) || 2)));
  if (!/\/torrents\.php$/i.test(url.pathname)) return [url.toString()];

  url.searchParams.set('allsec', '1');
  url.searchParams.set('inclbookmarked', '0');
  url.searchParams.set('incldead', '0');
  url.searchParams.set('spstate', '0');
  url.searchParams.set('sort', '4');
  url.searchParams.set('type', 'desc');
  url.searchParams.delete('page');

  return Array.from({ length: count }, (_, page) => {
    const pageUrl = new URL(url.toString());
    if (page > 0) pageUrl.searchParams.set('page', String(page));
    return pageUrl.toString();
  });
};

exports.isChdOfficialTitle = function (name) {
  return chdOfficialTitlePattern.test(String(name || ''));
};

exports.applyChdClassification = function (torrent, options = {}) {
  const siteOfficial = options.siteOfficial === undefined
    ? exports.isChdOfficialTitle(torrent.name)
    : !!options.siteOfficial;
  const siteRevived = !!options.siteRevived;
  const siteRepost = !siteOfficial && !siteRevived;
  const chdLabels = [];
  if (siteOfficial) chdLabels.push('官种');
  if (siteRevived) chdLabels.push('复活区');
  if (siteRepost) chdLabels.push('转载');

  return {
    ...torrent,
    siteOfficial: siteOfficial ? 1 : 0,
    siteRevived: siteRevived ? 1 : 0,
    siteRepost: siteRepost ? 1 : 0,
    chdCategory: siteRevived ? '复活区' : (siteOfficial ? '官种' : '转载'),
    chdLabels
  };
};

exports.parseChd = function (html, pageUrl, cookie) {
  const document = new JSDOM(html, { url: pageUrl }).window.document;
  const isRevivalPage = /\/renewtorrents\.php$/i.test(new URL(pageUrl).pathname);
  const loginForm = document.querySelector('form[action*="takelogin"]');
  if (loginForm || !document.querySelector('table.torrents')) {
    throw new Error('网页监控未找到种子列表，请检查登录 Cookie 是否有效');
  }

  const torrents = [];
  const rows = Array.from(document.querySelectorAll('table.torrents > tbody > tr'));
  for (const row of rows) {
    const titleAnchor = Array.from(row.querySelectorAll('a[href*="details.php?id="]')).find(anchor => anchor.querySelector('b'));
    const downloadAnchor = row.querySelector('a[href*="download.php?id="]');
    if (!titleAnchor || !downloadAnchor) continue;

    const detailsUrl = new URL(titleAnchor.getAttribute('href'), pageUrl).toString();
    const downloadUrl = new URL(downloadAnchor.getAttribute('href'), pageUrl).toString();
    const id = new URL(detailsUrl).searchParams.get('id');
    if (!id) continue;

    const directCells = Array.from(row.children);
    const baseSourceKey = torrentIdentity.getTorrentSourceKey({ id, link: detailsUrl, url: downloadUrl }, pageUrl);
    const timeText = row.querySelector('td.rowfollow.nowrap span[title]')?.getAttribute('title') || '';
    const originalPubTime = parseChdTime(timeText);
    const rowTimes = Array.from(row.querySelectorAll('span[title]'))
      .map(element => parseChdTime(element.getAttribute('title')))
      .filter(Boolean);
    const freeExpiresAt = isRevivalPage && rowTimes.length > 0 ? Math.max(...rowTimes) : 0;
    const revivalTime = isRevivalPage && freeExpiresAt > originalPubTime
      ? freeExpiresAt - chdRevivalFreeSeconds
      : 0;
    const sourceKey = revivalTime > 0 ? `${baseSourceKey}:revived:${revivalTime}` : baseSourceKey;
    const hash = crypto.createHash('sha1').update(`web-monitor:${sourceKey}`).digest('hex');
    const siteOfficial = Array.from(row.querySelectorAll('*'))
      .some(element => element.textContent.replace(/\u00a0/g, ' ').trim() === '官方');
    torrents.push(exports.applyChdClassification({
      id,
      hash,
      name: titleAnchor.querySelector('b').textContent.trim(),
      size: parseSizeText(directCells[4]?.textContent || ''),
      link: detailsUrl,
      url: downloadUrl,
      description: row.textContent.replace(/\s+/g, ' ').trim(),
      pubTime: revivalTime || originalPubTime,
      originalPubTime,
      revivalTime,
      freeExpiresAt,
      sourceKey,
      sourceType: 'web',
      downloadCookie: cookie
    }, {
      siteOfficial,
      siteRevived: isRevivalPage
    }));
  }
  return torrents;
};
