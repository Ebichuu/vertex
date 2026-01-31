const express = require('express');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ws = require('express-ws');
const app = express();
const router = express.Router();
const cron = require('node-cron');

const Push = require('./common/Push');
const Script = require('./common/Script');
const Client = require('./common/Client');
const Rss = require('./common/Rss');
const Server = require('./common/Server');
const Douban = require('./common/Douban');
const Site = require('./common/Site');
const Watch = require('./common/Watch');
const IRC = require('./common/IRC');

const sites = require('./libs/site');
const logger = require('./libs/logger');
const util = require('./libs/util');
const config = require('./libs/config');
const { execSync } = require('child_process');
logger.use(app);

const initPush = function () {
  const webhookPush = util.listPush().filter(item => item.id === global.webhookPushTo)[0];
  if (webhookPush) {
    global.webhookPush = new Push({ ...webhookPush, push: true });
  }
  const doubanPush = util.listPush().filter(item => item.id === global.doubanPush)[0];
  if (doubanPush) {
    global.doubanPush = new Push({ ...doubanPush, push: true });
  }
};

const init = function () {
  let dailyStatsRunning = false;
  const runDailyStatsJob = async (jobName, fn) => {
    if (dailyStatsRunning) {
      logger.warn(`${jobName} 跳过执行: 已有统计任务正在运行`);
      return;
    }
    dailyStatsRunning = true;
    try {
      await fn();
    } finally {
      dailyStatsRunning = false;
    }
  };

  global.clearDatabase = cron.schedule('1 0 * * *', async () => {
    try {
      logger.info('开始执行数据库清理任务...');
      await util.runRecord('delete from torrent_flow where time < ?', [moment().unix() - 1]);
      await util.runRecord('delete from tracker_flow where time < ?', [moment().unix() - 7 * 24 * 3600]);
      execSync('rm -f /tmp/Vertex-backups-*');
      logger.info('数据库清理任务完成');
    } catch (e) {
      logger.error('数据库清理任务失败:', e);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  // 每日统计聚合定时任务 - 每天凌晨2点执行
  global.dailyStatsAggregation = cron.schedule('0 2 * * *', async () => {
    try {
      await runDailyStatsJob('每日统计聚合任务', async () => {
        logger.info('开始执行每日统计聚合...');
        await util.aggregateDailyStats();
        logger.info('每日统计聚合完成');
      });
    } catch (e) {
      logger.error('每日统计聚合失败:', e);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  // 每日统计补偿任务 - 凌晨2:10检查最近几天是否有遗漏
  global.dailyStatsEnsure = cron.schedule('10 2 * * *', async () => {
    try {
      await runDailyStatsJob('每日统计补偿任务', async () => {
        logger.info('开始执行每日统计补偿...');
        await util.ensureDailyStats({ days: 7, skipEmpty: true });
        logger.info('每日统计补偿完成');
      });
    } catch (e) {
      logger.error('每日统计补偿失败:', e);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  // 添加定时任务状态监控
  logger.info('核心维护定时任务已启动 (中国时区):');
  logger.info('- 数据库清理任务: 每天凌晨0点1分执行');
  logger.info('- 每日统计聚合任务: 每天凌晨2点执行');
  logger.info('- 每日统计补偿任务: 每天凌晨2点10分执行');

  // 添加队列监控任务
  global.queueMonitor = cron.schedule('*/30 * * * * *', async () => {
    try {
      if (global.clientTaskQueue) {
        const clientStatus = await global.clientTaskQueue.getQueueStatus();
        logger.debug('客户端队列状态:', clientStatus);
        
        if (clientStatus.total > 20) {
          logger.warn(`客户端队列积压严重: ${clientStatus.total} 个任务待处理, 活跃工作者: ${clientStatus.activeWorkers}/${clientStatus.maxConcurrent}`);
        }
      }
      
      if (global.rssTaskQueue) {
        const rssStatus = await global.rssTaskQueue.getQueueStatus();
        logger.debug('RSS队列状态:', rssStatus);
        
        if (rssStatus.total > 10) {
          logger.warn(`RSS队列积压严重: ${rssStatus.total} 个任务待处理, 活跃工作者: ${rssStatus.activeWorkers}/${rssStatus.maxConcurrent}`);
        }
      }

      // 每5分钟输出一次详细统计
      const now = moment();
      if (now.minute() % 5 === 0 && now.second() < 30) {
        const clientTasks = Object.keys(global.runningClient || {}).length;
        const rssTasks = Object.keys(global.runningRss || {}).length;
        const siteTasks = Object.keys(global.runningSite || {}).length;
        
        logger.info(`=== 任务队列统计 ===`);
        logger.info(`客户端数量: ${clientTasks}, RSS任务数量: ${rssTasks}, 站点数量: ${siteTasks}`);
        
        if (global.clientTaskQueue) {
          const clientStatus = await global.clientTaskQueue.getQueueStatus();
          const blockedClients = global.clientTaskQueue.getBlockedClientsStatus();
          
          logger.info(`客户端队列: ${clientStatus.total} 待处理, ${clientStatus.activeWorkers}/${clientStatus.maxConcurrent} 工作者`);
          
        if (blockedClients.length > 0) {
          logger.info(`阻塞的客户端 (${blockedClients.length}): `, 
            blockedClients.map(c => `${c.clientId}(${c.failures}次失败,${c.remainingTime}秒,清理${c.clearedTasks}个任务)`).join(', '));
        }
        }
        
        if (global.rssTaskQueue) {
          const rssStatus = await global.rssTaskQueue.getQueueStatus();
          const blockedRss = global.rssTaskQueue.getBlockedRssStatus();
          
          logger.info(`RSS队列: ${rssStatus.total} 待处理, ${rssStatus.activeWorkers}/${rssStatus.maxConcurrent} 工作者`);
          
          if (blockedRss.length > 0) {
            logger.info(`阻塞的RSS源 (${blockedRss.length}): `, 
              blockedRss.map(r => `${r.rssId}(${r.failures}次失败,${r.remainingTime}秒)`).join(', '));
          }
        }
        logger.info(`=====================`);
      }
    } catch (error) {
      logger.error('队列监控失败:', error);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });
  
  // 添加测试任务状态的辅助函数
  global.testDailyStatsTask = async () => {
    try {
      await runDailyStatsJob('手动测试每日统计聚合任务', async () => {
        logger.info('手动测试每日统计聚合任务...');
        await util.aggregateDailyStats();
        logger.info('手动测试完成');
      });
      return true;
    } catch (e) {
      logger.error('手动测试失败:', e);
      return false;
    }
  };

  // 启动后补齐最近几天统计数据（避免错过定时任务）
  setTimeout(() => {
    runDailyStatsJob('启动补偿任务', async () => {
      logger.info('启动补偿: 检查最近统计数据缺口...');
      await util.ensureDailyStats({ days: 7, skipEmpty: true });
      logger.info('启动补偿: 完成');
    }).catch(e => logger.error('启动补偿失败:', e));
  }, 60 * 1000);

  // 在启动时检查定时任务状态
  logger.info('定时任务状态:');
  logger.info('- 数据库清理任务:', global.clearDatabase ? '已启动' : '未启动');
  logger.info('- 每日统计聚合任务:', global.dailyStatsAggregation ? '已启动' : '未启动');
  logger.info('- 每日统计补偿任务:', global.dailyStatsEnsure ? '已启动' : '未启动');

  global.CONFIG = config;
  global.LOGGER = logger;
  global.SITE = sites;
  global.linkMapping = JSON.parse(fs.readFileSync(path.join(__dirname, './data/link-mapping.json')));
  const setting = JSON.parse(fs.readFileSync(path.join(__dirname, './data/setting.json')));
  if (!setting.password) {
    const password = util.uuid.v4();
    setting.username = 'admin';
    setting.password = util.md5(password);
    fs.writeFileSync(path.join(__dirname, './data/password'), password);
    fs.writeFileSync(path.join(__dirname, './data/setting.json'), JSON.stringify(setting, null, 2));
  }
  const proxySetting = JSON.parse(fs.readFileSync(path.join(__dirname, './data/setting/proxy.json')));
  global.proxy = proxySetting.proxy;
  global.domains = proxySetting.domains;
  global.auth = {
    username: setting.username,
    password: setting.password,
    otp: setting.otp
  };
  global.telegramProxy = setting.telegramProxy || 'https://api.telegram.org';
  global.wechatProxy = setting.wechatProxy;
  global.checkFinishCron = setting.checkFinishCron || '30 * * * * *';
  global.userAgent = setting.userAgent;
  global.ignoreError = setting.ignoreError;
  global.ignoreDependCheck = setting.ignoreDependCheck;
  global.webhookPushTo = setting.webhookPushTo;
  global.doubanPush = setting.doubanPush;
  global.apiKey = setting.apiKey;
  global.tmdbApiKey = setting.tmdbApiKey;
  global.trustVertexPanel = setting.trustVertexPanel;
  global.transparent = setting.transparent;
  global.background = setting.background;
  global.wechatCover = setting.wechatCover;
  global.embyCover = setting.embyCover;
  global.plexCover = setting.plexCover;
  global.theme = setting.theme || 'light';
  global.siteInfo = setting.siteInfo || {
    hide: [],
    hideName: [],
    watermark: 'vertex'
  };
  global.trustAllCerts = setting.trustAllCerts;
  global.menu = setting.menu || [];
  global.dashboardContent = setting.dashboardContent || [];
  global.wechatToken = setting.wechatToken;
  global.wechatAesKey = setting.wechatAesKey;
  global.panelKey = setting.panelKey;
  global.jellyfinCover = setting.jellyfinCover;
  global.dataPath = setting.dataPath || '/';
  global.runningClient = {};
  global.runningRss = {};
  global.runningServer = {};
  global.runningSite = {};
  global.runningRace = {};
  global.runningDouban = {};
  global.runningScript = {};
  global.runningWatch = {};
  global.runningIRC = {};
  global.startTime = moment().unix();
  initPush();
  for (const client of util.listClient()) {
    if (client.enable) {
      global.runningClient[client.id] = new Client(client);
    }
  }
  for (const rss of util.listRss()) {
    if (rss.enable) {
      global.runningRss[rss.id] = new Rss(rss);
    }
  }
  for (const server of util.listServer()) {
    if (server.enable) {
      global.runningServer[server.id] = new Server(server);
    }
  }
  for (const site of util.listSite()) {
    if (site.enable) {
      global.runningSite[site.name] = new Site(site);
    }
  }
  for (const douban of util.listDouban()) {
    if (douban.enable) {
      global.runningDouban[douban.id] = new Douban(douban);
    }
  }
  for (const script of util.listCrontabJavaScript()) {
    if (script.enable) {
      global.runningScript[script.id] = new Script(script);
    }
  }
  for (const watch of util.listWatch()) {
    if (watch.enable) {
      global.runningWatch[watch.id] = new Watch(watch);
    }
  }
  for (const irc of util.listIRC()) {
    if (irc.enable) {
      global.runningIRC[irc.id] = new IRC(irc);
    }
  }
  // cookiecloud
  util.initCookieCloud();
};

(async () => {
  try {
    init();
  } catch (e) {
    logger.error('初始化任务报错\n', e);
  }
  try {
    const server = http.createServer(app).listen(process.env.PORT);
    ws(app, server);
    logger.info('HTTP 服务器启动, 监听端口: ', process.env.PORT);
  } catch (e) {
    logger.error(e);
    logger.error('HTTP 服务器启动失败, 监听端口: ', process.env.PORT);
  }
  if (process.env.HTTPS_ENABLE === 'true') {
    try {
      const options = {
        key: fs.readFileSync(path.join(__dirname, './data/ssl/https.key')),
        cert: fs.readFileSync(path.join(__dirname, './data/ssl/https.crt'))
      };
      const server = https.createServer(options, app).listen(process.env.HTTPS_PORT);
      ws(app, server);
      logger.info('HTTPS 服务器启动, 监听端口: ', process.env.HTTPS_PORT);
    } catch (e) {
      logger.error(e);
      logger.error('HTTPS 服务器启动失败, 监听端口: ', process.env.HTTPS_PORT);
    }
  }
  require('./routes/router.js')(app, express, router);
  
  // 添加优雅关闭处理器
  setupGracefulShutdown();
})();

// 优雅关闭函数
function setupGracefulShutdown() {
  const gracefulShutdown = async (signal) => {
    logger.info(`收到 ${signal} 信号，开始优雅关闭应用...`);
    
    try {
      // 停止所有定时任务
      if (global.clearDatabase) {
        global.clearDatabase.stop();
        logger.info('数据库清理定时任务已停止');
      }
      
      if (global.dailyStatsAggregation) {
        global.dailyStatsAggregation.stop();
        logger.info('每日统计聚合定时任务已停止');
      }
      
      if (global.dailyStatsEnsure) {
        global.dailyStatsEnsure.stop();
        logger.info('每日统计补偿定时任务已停止');
      }
      
      if (global.cookiecloud) {
        global.cookiecloud.stop();
        logger.info('CookieCloud 同步任务已停止');
      }
      
      if (global.queueMonitor) {
        global.queueMonitor.stop();
        logger.info('队列监控任务已停止');
      }
      
      // 停止所有运行中的组件
      for (const client of Object.values(global.runningClient || {})) {
        if (client.destroy) {
          client.destroy();
        }
      }
      logger.info('所有下载器实例已停止');
      
      for (const rss of Object.values(global.runningRss || {})) {
        if (rss.destroy) {
          rss.destroy();
        }
      }
      logger.info('所有 RSS 实例已停止');
      
      for (const server of Object.values(global.runningServer || {})) {
        if (server.destroy) {
          await server.destroy();
        }
      }
      logger.info('所有服务器连接已关闭');
      
      for (const site of Object.values(global.runningSite || {})) {
        if (site.destroy) {
          site.destroy();
        }
      }
      logger.info('所有站点实例已停止');
      
      for (const douban of Object.values(global.runningDouban || {})) {
        if (douban.destroy) {
          douban.destroy();
        }
      }
      logger.info('所有豆瓣实例已停止');
      
      for (const script of Object.values(global.runningScript || {})) {
        if (script.destroy) {
          script.destroy();
        }
      }
      logger.info('所有脚本实例已停止');
      
      for (const watch of Object.values(global.runningWatch || {})) {
        if (watch.destroy) {
          watch.destroy();
        }
      }
      logger.info('所有监控实例已停止');
      
      for (const irc of Object.values(global.runningIRC || {})) {
        if (irc.destroy) {
          irc.destroy();
        }
      }
      logger.info('所有 IRC 实例已停止');
      
      // 最后关闭数据库连接
      util.closeDatabase();
      
      logger.info('应用已优雅关闭');
      process.exit(0);
    } catch (error) {
      logger.error('优雅关闭过程中发生错误:', error);
      process.exit(1);
    }
  };
  
  // 监听各种退出信号
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker stop 命令
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
  process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT')); // Quit 信号
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));   // 终端关闭
  
  // 处理未捕获的异常和拒绝
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常:', error);
    gracefulShutdown('uncaughtException');
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的 Promise 拒绝:', reason);
    gracefulShutdown('unhandledRejection');
  });
  
  logger.info('优雅关闭处理器已设置');
}
