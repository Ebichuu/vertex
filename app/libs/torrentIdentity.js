const getTorrentSourceKey = function (torrent, sourceUrl) {
  const urls = [torrent && torrent.link, torrent && torrent.url, sourceUrl].filter(Boolean);
  let fallbackHost = '';
  for (const item of urls) {
    try {
      const parsed = new URL(item, sourceUrl);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      fallbackHost = fallbackHost || host;
      const id = parsed.searchParams.get('id');
      if (id) return `${host}:${id}`;
    } catch (e) {}
  }
  const id = String((torrent && torrent.id) || '').match(/\d+/)?.[0];
  if (fallbackHost && id) return `${fallbackHost}:${id}`;
  return '';
};

exports.getTorrentSourceKey = getTorrentSourceKey;
