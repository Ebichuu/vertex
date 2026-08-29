import { get, post } from '../util/axios';

export default {
  list: async () => await get('/api/webMonitor/list'),
  modify: async (monitor) => await post('/api/webMonitor/' + (monitor.id ? 'modify' : 'add'), monitor),
  delete: async (id) => await post('/api/webMonitor/delete', { id })
};
