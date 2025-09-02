import { get, post } from '../util/axios';

export default {
  get: async () => {
    const url = '/api/setting/get';
    return await get(url);
  },
  modify: async (body) => {
    const url = '/api/setting/modify';
    return await post(url, body);
  },
  getTrackerFlowHistory: async () => {
    const url = '/api/setting/getTrackerFlowHistory';
    return await get(url);
  },
  getRunInfo: async () => {
    const url = '/api/setting/getRunInfo?_=' + Math.random();
    return await get(url);
  },
  getHosts: async () => {
    const url = '/api/setting/getHosts';
    return await get(url);
  },
  save: async (body) => {
    const url = '/api/setting/save';
    return await post(url, body);
  },
  export: async () => {
    const url = '/api/setting/export';
    return await get(url);
  },
  import: async () => {
    const url = '/api/setting/import';
    return await get(url);
  },
  loginMTeam: async (body) => {
    const url = '/api/setting/loginMTeam';
    return await post(url, body);
  },
  networkTest: async (body) => {
    const url = '/api/setting/networkTest';
    return await post(url, body);
  },
  getProxy: async () => {
    const url = '/api/setting/getProxy';
    return await get(url);
  },
  saveProxy: async (body) => {
    const url = '/api/setting/saveProxy';
    return await post(url, body);
  },
  clearHistory: async () => {
    const url = '/api/setting/clearHistory';
    return await post(url, {});
  },
  testDailyStatsTask: async () => {
    const url = '/api/setting/testDailyStatsTask';
    return await get(url);
  },
  getCronStatus: async () => {
    const url = '/api/setting/getCronStatus';
    return await get(url);
  },
  checkMissingDailyStats: async () => {
    const url = '/api/setting/checkMissingDailyStats';
    return await get(url);
  },
  backfillDailyStats: async () => {
    const url = '/api/setting/backfillDailyStats';
    return await get(url);
  },
  cleanExpiredFlowData: async () => {
    const url = '/api/setting/cleanExpiredFlowData';
    return await post(url, {});
  },
  cleanOldTorrents: async (keepMonths) => {
    const url = '/api/setting/cleanOldTorrents';
    return await post(url, { keepMonths });
  }
};
