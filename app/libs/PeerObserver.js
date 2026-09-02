const crypto = require('crypto');

const numberOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const textOrEmpty = value => typeof value === 'string' ? value : '';

class PeerObserver {
  constructor (options = {}) {
    this.enabled = options.enabled !== false;
    this.logger = options.logger || console;
    this.store = options.store;
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || (delay => new Promise(resolve => {
      const timer = setTimeout(resolve, delay);
      if (timer.unref) timer.unref();
    }));
    this.fastIntervalMs = numberOr(options.fastIntervalMs, 1000);
    this.slowIntervalMs = numberOr(options.slowIntervalMs, 5000);
    this.fastWindowMs = numberOr(options.fastWindowMs, 5 * 60 * 1000);
    this.maxDurationMs = numberOr(options.maxDurationMs, 20 * 60 * 1000);
    this.postCompletionMs = numberOr(options.postCompletionMs, 60 * 1000);
    this.maxConcurrent = Math.max(1, numberOr(options.maxConcurrent, 12));
    this.maxConsecutiveErrors = Math.max(1, numberOr(options.maxConsecutiveErrors, 5));
    this.persistIntervalMs = numberOr(options.persistIntervalMs, 30 * 1000);
    this.secret = options.secret || crypto.randomBytes(32);
    this.active = new Map();
    this.queuedKeys = new Set();
    this.queue = [];
    this.stopped = false;
  }

  observe (client, hash, metadata = {}) {
    if (!this.enabled || this.stopped || !client || !client._client || client._client.type !== 'qBittorrent') return false;
    const torrentHash = String(hash || '').trim().toLowerCase();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(torrentHash)) {
      this.logger.warn('Peer 观察器跳过无效 infohash:', metadata.torrentName || torrentHash || 'unknown');
      return false;
    }
    const key = `${client.id}:${torrentHash}`;
    if (this.active.has(key) || this.queuedKeys.has(key)) return false;
    this.queuedKeys.add(key);
    this.queue.push({ key, client, torrentHash, metadata });
    setImmediate(() => this._drain());
    return true;
  }

  stop () {
    this.stopped = true;
    this.queue = [];
    this.queuedKeys.clear();
  }

  getStatus () {
    return {
      enabled: this.enabled,
      active: this.active.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent
    };
  }

  _drain () {
    if (this.stopped) return;
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const item = this.queue.shift();
      this.queuedKeys.delete(item.key);
      this.active.set(item.key, item);
      Promise.resolve()
        .then(() => this._run(item))
        .catch(error => this.logger.error('Peer 观察器会话异常:', error.message))
        .finally(() => {
          this.active.delete(item.key);
          this._drain();
        });
    }
  }

  _fingerprint (peerKey) {
    return crypto.createHmac('sha256', this.secret)
      .update(peerKey)
      .digest('hex')
      .substring(0, 24);
  }

  _getLocalTorrent (client, hash) {
    if (!client.maindata || !Array.isArray(client.maindata.torrents)) return null;
    return client.maindata.torrents.find(torrent => String(torrent.hash || '').toLowerCase() === hash) || null;
  }

  _makePeerState (peerKey, peer, sampleAt) {
    const progress = numberOr(peer.progress, 0);
    const isComplete = progress >= 0.999999;
    return {
      peerKey: this._fingerprint(peerKey),
      firstSeenAt: sampleAt,
      lastSeenAt: sampleAt,
      removedAt: null,
      firstProgress: progress,
      maxProgress: progress,
      firstCompleteAt: isComplete ? sampleAt : null,
      completeOnFirstSeen: isComplete,
      clientName: textOrEmpty(peer.client || peer.peer_id_client),
      connection: textOrEmpty(peer.connection),
      countryCode: textOrEmpty(peer.country_code),
      flags: textOrEmpty(peer.flags),
      maxDownloadSpeed: numberOr(peer.dl_speed, 0),
      maxUploadSpeed: numberOr(peer.up_speed, 0),
      downloaded: numberOr(peer.downloaded, 0),
      uploaded: numberOr(peer.uploaded, 0),
      sampleCount: 1,
      lastPersistAt: 0,
      persistedComplete: false
    };
  }

  _updatePeerState (state, peer, sampleAt) {
    const progress = numberOr(peer.progress, state.maxProgress);
    state.lastSeenAt = sampleAt;
    state.removedAt = null;
    state.maxProgress = Math.max(state.maxProgress, progress);
    if (!state.firstCompleteAt && progress >= 0.999999) state.firstCompleteAt = sampleAt;
    state.clientName = textOrEmpty(peer.client || peer.peer_id_client) || state.clientName;
    state.connection = textOrEmpty(peer.connection) || state.connection;
    state.countryCode = textOrEmpty(peer.country_code) || state.countryCode;
    state.flags = textOrEmpty(peer.flags) || state.flags;
    state.maxDownloadSpeed = Math.max(state.maxDownloadSpeed, numberOr(peer.dl_speed, 0));
    state.maxUploadSpeed = Math.max(state.maxUploadSpeed, numberOr(peer.up_speed, 0));
    state.downloaded = Math.max(state.downloaded, numberOr(peer.downloaded, 0));
    state.uploaded = Math.max(state.uploaded, numberOr(peer.uploaded, 0));
    state.sampleCount += 1;
  }

  _needsPersist (state, sampleAt, isNew) {
    return isNew ||
      (!state.persistedComplete && !!state.firstCompleteAt) ||
      sampleAt * 1000 - state.lastPersistAt >= this.persistIntervalMs;
  }

  _markPersisted (state, sampleAt) {
    state.lastPersistAt = sampleAt * 1000;
    state.persistedComplete = !!state.firstCompleteAt;
  }

  _publicPeerState (state) {
    return {
      peerKey: state.peerKey,
      firstSeenAt: state.firstSeenAt,
      lastSeenAt: state.lastSeenAt,
      removedAt: state.removedAt,
      firstProgress: state.firstProgress,
      maxProgress: state.maxProgress,
      firstCompleteAt: state.firstCompleteAt,
      completeOnFirstSeen: state.completeOnFirstSeen,
      clientName: state.clientName,
      connection: state.connection,
      countryCode: state.countryCode,
      flags: state.flags,
      maxDownloadSpeed: state.maxDownloadSpeed,
      maxUploadSpeed: state.maxUploadSpeed,
      downloaded: state.downloaded,
      uploaded: state.uploaded,
      sampleCount: state.sampleCount
    };
  }

  async _consumeSnapshot (sessionId, response, states, activeKeys, sampleAt, pollCount) {
    const changed = [];
    const peers = response && response.peers && typeof response.peers === 'object' ? response.peers : {};
    const presentKeys = new Set(Object.keys(peers));
    const removedKeys = new Set(Array.isArray(response.peers_removed) ? response.peers_removed : []);
    if (response.full_update && pollCount > 0) {
      for (const peerKey of activeKeys) {
        if (!presentKeys.has(peerKey)) removedKeys.add(peerKey);
      }
    }

    for (const [peerKey, peerDelta] of Object.entries(peers)) {
      let state = states.get(peerKey);
      const isNew = !state;
      if (!state) {
        state = this._makePeerState(peerKey, peerDelta, sampleAt);
        states.set(peerKey, state);
      } else {
        this._updatePeerState(state, peerDelta, sampleAt);
      }
      activeKeys.add(peerKey);
      if (this._needsPersist(state, sampleAt, isNew)) {
        changed.push(this._publicPeerState(state));
        this._markPersisted(state, sampleAt);
      }
    }

    for (const peerKey of removedKeys) {
      const state = states.get(peerKey);
      if (!state || !activeKeys.has(peerKey)) continue;
      state.removedAt = sampleAt;
      state.lastSeenAt = Math.min(state.lastSeenAt, sampleAt);
      activeKeys.delete(peerKey);
      changed.push(this._publicPeerState(state));
      this._markPersisted(state, sampleAt);
    }

    await this.store.upsertPeers(sessionId, changed);
  }

  async _run (item) {
    const startedMs = this.now();
    const startedAt = Math.floor(startedMs / 1000);
    const metadata = item.metadata || {};
    let sessionId;
    try {
      sessionId = await this.store.startSession({
        clientId: item.client.id,
        torrentHash: item.torrentHash,
        torrentName: metadata.torrentName,
        torrentSize: metadata.torrentSize,
        rssId: metadata.rssId,
        rssAlias: metadata.rssAlias,
        sourceType: metadata.sourceType,
        startedAt
      });
    } catch (error) {
      this.logger.error('Peer 观察器无法创建会话:', error.message);
      return;
    }

    const states = new Map();
    const activeKeys = new Set();
    let rid = 0;
    let pollCount = 0;
    let consecutiveErrors = 0;
    let lastError = '';
    let status = 'timeout';
    let localCompletedAt = null;
    let localTorrentSeen = false;

    while (!this.stopped && this.now() - startedMs < this.maxDurationMs) {
      const sampleAt = Math.floor(this.now() / 1000);
      try {
        const response = await item.client.getTorrentPeers(item.torrentHash, rid);
        await this._consumeSnapshot(sessionId, response, states, activeKeys, sampleAt, pollCount);
        if (Number.isFinite(Number(response.rid))) rid = Number(response.rid);
        pollCount += 1;
        consecutiveErrors = 0;
        lastError = '';

        const localTorrent = this._getLocalTorrent(item.client, item.torrentHash);
        if (localTorrent) {
          localTorrentSeen = true;
          const complete = Number(localTorrent.progress) >= 0.999999 ||
            (Number(localTorrent.size) > 0 && Number(localTorrent.completed) >= Number(localTorrent.size));
          if (complete && !localCompletedAt) localCompletedAt = sampleAt;
        } else if (localTorrentSeen) {
          status = 'torrent_removed';
          break;
        }
        if (localCompletedAt && sampleAt * 1000 - localCompletedAt * 1000 >= this.postCompletionMs) {
          status = 'completed';
          break;
        }
      } catch (error) {
        consecutiveErrors += 1;
        lastError = String(error.message || error).substring(0, 500);
        if (consecutiveErrors >= this.maxConsecutiveErrors) {
          status = 'error';
          break;
        }
      }

      const elapsed = this.now() - startedMs;
      await this.sleep(elapsed < this.fastWindowMs ? this.fastIntervalMs : this.slowIntervalMs);
    }

    if (this.stopped) status = 'stopped';
    const endedAt = Math.floor(this.now() / 1000);
    const finalPeers = Array.from(states.values()).map(state => this._publicPeerState(state));
    try {
      await this.store.upsertPeers(sessionId, finalPeers);
      const completePeers = finalPeers.filter(peer => peer.firstCompleteAt);
      const initialCompletePeers = finalPeers.filter(peer => peer.completeOnFirstSeen);
      await this.store.finishSession(sessionId, {
        endedAt,
        status,
        pollCount,
        peerCount: finalPeers.length,
        completePeerCount: completePeers.length,
        initialCompletePeerCount: initialCompletePeers.length,
        firstCompletePeerAt: completePeers.length ? Math.min(...completePeers.map(peer => peer.firstCompleteAt)) : null,
        localCompletedAt,
        lastError
      });
      this.logger.info('Peer 观察完成:', metadata.torrentName || item.torrentHash.substring(0, 8),
        `状态=${status}, 轮询=${pollCount}, peers=${finalPeers.length}, 初见100%=${initialCompletePeers.length}`);
    } catch (error) {
      this.logger.error('Peer 观察器保存会话失败:', error.message);
    }
  }
}

module.exports = PeerObserver;
