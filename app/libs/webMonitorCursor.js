class WebMonitorCursor {
  constructor (options = {}) {
    this.startedAt = options.startedAt || Math.floor(Date.now() / 1000);
    this.initialLookbackSeconds = Math.max(0, Number(options.initialLookbackSeconds) || 0);
    this.maxEntries = Math.max(1000, Number(options.maxEntries) || 10000);
    this.initialized = false;
    this.lastSkippedCount = 0;
    this.seen = new Map();
  }

  _key (torrent) {
    return torrent.sourceKey || torrent.hash || torrent.url || torrent.link || `${torrent.name || ''}:${torrent.size || 0}`;
  }

  _prune () {
    if (this.seen.size <= this.maxEntries) return;
    const removeCount = this.seen.size - Math.floor(this.maxEntries * 0.8);
    const keys = this.seen.keys();
    for (let index = 0; index < removeCount; index++) {
      const key = keys.next().value;
      if (!key) break;
      this.seen.delete(key);
    }
  }

  selectNew (torrents, options = {}) {
    const firstRun = !this.initialized;
    const cutoff = this.startedAt - this.initialLookbackSeconds;
    const now = Number(options.now) || Math.floor(Date.now() / 1000);
    const maxAgeSeconds = Math.max(0, Number(options.maxAgeSeconds) || 0);
    const skipAll = !!options.skipAll;
    const selected = [];
    this.lastSkippedCount = 0;

    for (const torrent of torrents) {
      const key = this._key(torrent);
      if (!key || this.seen.has(key)) continue;
      this.seen.set(key, Date.now());
      const outsideStartupWindow = firstRun && !(torrent.pubTime > 0 && torrent.pubTime >= cutoff);
      const tooOld = maxAgeSeconds > 0 && (!(torrent.pubTime > 0) || now - torrent.pubTime > maxAgeSeconds);
      if (skipAll || outsideStartupWindow || tooOld) {
        this.lastSkippedCount += 1;
        continue;
      }
      selected.push(torrent);
    }

    this.initialized = true;
    this._prune();
    return selected;
  }

  forget (torrents) {
    for (const torrent of torrents) {
      const key = this._key(torrent);
      if (key) this.seen.delete(key);
    }
  }
}

module.exports = WebMonitorCursor;
