class TorrentBatchBuffer {
  constructor () {
    this.batches = new Map();
  }

  _key (torrent) {
    return torrent.sourceKey || torrent.hash || torrent.url || torrent.link || `${torrent.name || ''}:${torrent.size || 0}`;
  }

  merge (rssId, torrents) {
    let batch = this.batches.get(rssId);
    if (!batch) {
      batch = new Map();
      this.batches.set(rssId, batch);
    }
    for (const torrent of torrents || []) {
      const key = this._key(torrent);
      if (key && !batch.has(key)) batch.set(key, torrent);
    }
    return batch.size;
  }

  drain (rssId) {
    const batch = this.batches.get(rssId);
    this.batches.delete(rssId);
    return batch ? Array.from(batch.values()) : [];
  }

  size (rssId) {
    return this.batches.get(rssId)?.size || 0;
  }

  clear (rssId) {
    this.batches.delete(rssId);
  }
}

module.exports = TorrentBatchBuffer;
