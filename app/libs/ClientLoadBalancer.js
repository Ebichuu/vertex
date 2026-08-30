const DEFAULT_WEIGHTS = {
  upload: 0.45,
  torrents: 0.3,
  space: 0.25
};

class ClientLoadBalancer {
  constructor (clients, cursor, weights = DEFAULT_WEIGHTS) {
    this.clients = clients;
    this.cursor = cursor;
    this.weights = weights;
    this.plannedTorrentCount = {};
    this.plannedBytes = {};

    for (const client of clients) {
      this.plannedTorrentCount[client.id] = 0;
      this.plannedBytes[client.id] = 0;
    }
  }

  _getMetrics (client) {
    const maindata = client.maindata || {};
    const uploadCapacity = Math.max(1, Number(client.uploadBandwidth) || 125000000);
    const uploadUtilization = Math.max(0, Number(maindata.uploadSpeed) || 0) / uploadCapacity;
    const leechingCount = Math.max(0, Number(maindata.leechingCount) || 0);
    const seedingCount = Math.max(0, Number(maindata.seedingCount) || 0);
    const torrentLoad = leechingCount * 2 + seedingCount + this.plannedTorrentCount[client.id];
    const freeSpace = Math.max(0, (Number(maindata.freeSpaceOnDisk) || 0) - this.plannedBytes[client.id]);

    return { uploadUtilization, torrentLoad, freeSpace };
  }

  _scoreClients (clients) {
    const rows = clients.map(client => ({ client, metrics: this._getMetrics(client) }));
    const maxUploadUtilization = Math.max(0, ...rows.map(row => row.metrics.uploadUtilization));
    const maxTorrentLoad = Math.max(0, ...rows.map(row => row.metrics.torrentLoad));
    const maxFreeSpace = Math.max(0, ...rows.map(row => row.metrics.freeSpace));

    return rows.map(row => {
      const uploadPressure = maxUploadUtilization > 0
        ? row.metrics.uploadUtilization / maxUploadUtilization
        : 0;
      const torrentPressure = maxTorrentLoad > 0
        ? row.metrics.torrentLoad / maxTorrentLoad
        : 0;
      const spacePressure = maxFreeSpace > 0
        ? 1 - row.metrics.freeSpace / maxFreeSpace
        : 1;
      const score = uploadPressure * this.weights.upload +
        torrentPressure * this.weights.torrents +
        spacePressure * this.weights.space;

      return { ...row, score, uploadPressure, torrentPressure, spacePressure };
    });
  }

  select (torrentSize) {
    const size = Math.max(0, Number(torrentSize) || 0);
    const eligibleClients = this.clients.filter(client =>
      this._getMetrics(client).freeSpace > size
    );
    if (eligibleClients.length === 0) return undefined;

    const rankedClients = this._scoreClients(eligibleClients).sort((a, b) => a.score - b.score);
    const bestScore = rankedClients[0].score;
    const tiedClients = rankedClients
      .filter(row => Math.abs(row.score - bestScore) < 1e-12)
      .map(row => row.client);
    const selectedClient = this.cursor.select(tiedClients);
    this.plannedTorrentCount[selectedClient.id] += 1;
    this.plannedBytes[selectedClient.id] += size;
    return selectedClient;
  }

  getScoreDetails () {
    return this._scoreClients(this.clients);
  }
}

module.exports = ClientLoadBalancer;
