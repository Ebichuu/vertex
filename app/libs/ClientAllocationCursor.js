class ClientAllocationCursor {
  constructor (options) {
    this.store = options.store;
    this.logger = options.logger;
    this.alias = options.alias;
    this.key = `vertex:rss:client_cursor:${options.rssId}`;
    this.lastClientId = '';
    this.dirty = false;
  }

  async load () {
    try {
      const stored = await this.store.get(this.key);
      if (stored) {
        this.lastClientId = String(stored);
        this.logger.info(this.alias, `加载上次分配下载器: ${this.lastClientId}`);
      }
    } catch (error) {
      this.logger.error(this.alias, '加载下载器分配游标失败:', error);
    }
  }

  orderAfterLast (clients) {
    if (!Array.isArray(clients) || clients.length < 2 || !this.lastClientId) {
      return Array.isArray(clients) ? [...clients] : [];
    }

    const lastIndex = clients.findIndex(client => String(client.id) === this.lastClientId);
    if (lastIndex === -1) {
      return [...clients];
    }

    return clients.slice(lastIndex + 1).concat(clients.slice(0, lastIndex + 1));
  }

  select (clients, predicate = () => true) {
    const selectedClient = this.orderAfterLast(clients).find(predicate);
    if (!selectedClient) return undefined;

    this.lastClientId = String(selectedClient.id);
    this.dirty = true;
    return selectedClient;
  }

  async persist () {
    if (!this.dirty || !this.lastClientId) return;

    try {
      await this.store.set(this.key, this.lastClientId);
      this.dirty = false;
    } catch (error) {
      this.logger.error(this.alias, '持久化下载器分配游标失败:', error);
    }
  }
}

module.exports = ClientAllocationCursor;
