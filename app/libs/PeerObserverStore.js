const util = require('./util');

class PeerObserverStore {
  async startSession (session) {
    const result = await util.runRecord(`
      INSERT INTO peer_observer_sessions
        (client_id, torrent_hash, torrent_name, torrent_size, rss_id, rss_alias, source_type,
         started_at, status, poll_count, peer_count, complete_peer_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observing', 0, 0, 0)
    `, [
      session.clientId,
      session.torrentHash,
      session.torrentName || '',
      session.torrentSize || 0,
      session.rssId || '',
      session.rssAlias || '',
      session.sourceType || '',
      session.startedAt
    ]);
    return Number(result.lastInsertRowid);
  }

  async upsertPeers (sessionId, peers) {
    if (!peers.length) return;
    const rows = peers.map(peer => [
      sessionId,
      peer.peerKey,
      peer.firstSeenAt,
      peer.lastSeenAt,
      peer.removedAt,
      peer.firstProgress,
      peer.maxProgress,
      peer.firstCompleteAt,
      peer.completeOnFirstSeen ? 1 : 0,
      peer.clientName,
      peer.connection,
      peer.countryCode,
      peer.flags,
      peer.maxDownloadSpeed,
      peer.maxUploadSpeed,
      peer.downloaded,
      peer.uploaded,
      peer.sampleCount
    ]);
    await util.runRecords(`
      INSERT INTO peer_observer_peers
        (session_id, peer_key, first_seen_at, last_seen_at, removed_at, first_progress,
         max_progress, first_complete_at, complete_on_first_seen, client_name, connection,
         country_code, flags, max_download_speed, max_upload_speed, downloaded, uploaded,
         sample_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, peer_key) DO UPDATE SET
        first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
        removed_at = excluded.removed_at,
        max_progress = MAX(max_progress, excluded.max_progress),
        first_complete_at = COALESCE(first_complete_at, excluded.first_complete_at),
        complete_on_first_seen = MAX(complete_on_first_seen, excluded.complete_on_first_seen),
        client_name = CASE WHEN excluded.client_name = '' THEN client_name ELSE excluded.client_name END,
        connection = CASE WHEN excluded.connection = '' THEN connection ELSE excluded.connection END,
        country_code = CASE WHEN excluded.country_code = '' THEN country_code ELSE excluded.country_code END,
        flags = CASE WHEN excluded.flags = '' THEN flags ELSE excluded.flags END,
        max_download_speed = MAX(max_download_speed, excluded.max_download_speed),
        max_upload_speed = MAX(max_upload_speed, excluded.max_upload_speed),
        downloaded = MAX(downloaded, excluded.downloaded),
        uploaded = MAX(uploaded, excluded.uploaded),
        sample_count = MAX(sample_count, excluded.sample_count)
    `, rows);
  }

  async finishSession (sessionId, summary) {
    await util.runRecord(`
      UPDATE peer_observer_sessions SET
        ended_at = ?, status = ?, poll_count = ?, peer_count = ?, complete_peer_count = ?,
        initial_complete_peer_count = ?, first_complete_peer_at = ?, local_completed_at = ?, last_error = ?
      WHERE id = ?
    `, [
      summary.endedAt,
      summary.status,
      summary.pollCount,
      summary.peerCount,
      summary.completePeerCount,
      summary.initialCompletePeerCount,
      summary.firstCompletePeerAt,
      summary.localCompletedAt,
      summary.lastError || '',
      sessionId
    ]);
  }
}

module.exports = PeerObserverStore;
