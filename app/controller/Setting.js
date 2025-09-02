const logger = require('../libs/logger');
const SettingMod = require('../model/SettingMod');

const settingMod = new SettingMod();

class Setting {
  async get (req, res) {
    try {
      const r = settingMod.get();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getBackground (req, res) {
    try {
      const r = settingMod.getBackground();
      res.set('content-type', 'text/css');
      res.send(r);
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async modify (req, res) {
    const options = req.body;
    try {
      const r = settingMod.modify(options);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getTorrentHistorySetting (req, res) {
    try {
      const r = settingMod.getTorrentHistorySetting();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async modifyTorrentHistorySetting (req, res) {
    const options = req.body;
    try {
      const r = settingMod.modifyTorrentHistorySetting(options);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getTorrentMixSetting (req, res) {
    try {
      const r = settingMod.getTorrentMixSetting();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async modifyTorrentMixSetting (req, res) {
    const options = req.body;
    try {
      const r = settingMod.modifyTorrentMixSetting(options);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getTorrentPushSetting (req, res) {
    try {
      const r = settingMod.getTorrentPushSetting();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async modifyTorrentPushSetting (req, res) {
    const options = req.body;
    try {
      const r = settingMod.modifyTorrentPushSetting(options);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getSitePushSetting (req, res) {
    try {
      const r = settingMod.getSitePushSetting();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async modifySitePushSetting (req, res) {
    const options = req.body;
    try {
      const r = settingMod.modifySitePushSetting(options);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getRunInfo (req, res) {
    try {
      const r = await settingMod.getRunInfo();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async backupVertex (req, res) {
    try {
      const file = await settingMod.backupVertex(req.query);
      res.download(file);
    } catch (e) {
      logger.error(e);
      res.send({
        success: true,
        message: e.message
      });
    }
  }

  async restoreVertex (req, res) {
    try {
      const r = await settingMod.restoreVertex(req.files);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async networkTest (req, res) {
    try {
      const r = await settingMod.networkTest(req.body);
      res.send({
        success: true,
        data: r.body
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: true,
        data: e.toString()
      });
    }
  }

  async loginMTeam (req, res) {
    try {
      const r = await settingMod.loginMTeam(req.body);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getCss (req, res) {
    try {
      const r = settingMod.getCss();
      res.set('content-type', 'text/css');
      res.send(r);
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  };

  async getTrackerFlowHistory (req, res) {
    try {
      const r = await settingMod.getTrackerFlowHistory();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async getHosts (req, res) {
    try {
      const r = settingMod.getHosts();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async export (req, res) {
    try {
      const r = settingMod.export();
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async import (req, res) {
    try {
      const r = settingMod.import();
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async save (req, res) {
    try {
      const r = settingMod.save(req.body);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async getProxy (req, res) {
    try {
      const r = settingMod.getProxy();
      res.send({
        success: true,
        data: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async saveProxy (req, res) {
    try {
      const r = settingMod.saveProxy(req.body);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  async clearHistory (req, res) {
    try {
      const r = await settingMod.clearHistory(req.body);
      res.send({
        success: true,
        message: r
      });
    } catch (e) {
      logger.error(e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 调试方法：测试每日统计聚合任务
  async testDailyStatsTask (req, res) {
    try {
      const util = require('../libs/util');
      const moment = require('moment');
      
      // 获取当前时间和时区信息
      const currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
      const currentTimeZone = moment().format('Z');
      const chinaTime = moment().utcOffset(8 * 60).format('YYYY-MM-DD HH:mm:ss');
      
      logger.info(`调试信息 - 当前系统时间: ${currentTime} (${currentTimeZone})`);
      logger.info(`调试信息 - 中国时间: ${chinaTime} (+08:00)`);
      
      // 检查定时任务状态
      const taskStatus = {
        dailyStatsAggregation: global.dailyStatsAggregation ? '已启动' : '未启动',
        clearDatabase: global.clearDatabase ? '已启动' : '未启动'
      };
      
      logger.info('定时任务状态:', taskStatus);
      
      // 执行聚合任务
      await util.aggregateDailyStats();
      
      res.send({
        success: true,
        message: '每日统计聚合任务测试完成',
        data: {
          currentTime,
          currentTimeZone,
          chinaTime,
          taskStatus
        }
      });
    } catch (e) {
      logger.error('测试每日统计聚合任务失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 调试方法：获取定时任务状态
  async getCronStatus (req, res) {
    try {
      const moment = require('moment');
      const currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
      const chinaTime = moment().utcOffset(8 * 60).format('YYYY-MM-DD HH:mm:ss');
      
      const status = {
        systemTime: currentTime,
        chinaTime: chinaTime,
        timezone: moment().format('Z'),
        tasks: {
          dailyStatsAggregation: {
            exists: !!global.dailyStatsAggregation,
            status: global.dailyStatsAggregation ? '运行中' : '未启动'
          },
          clearDatabase: {
            exists: !!global.clearDatabase,
            status: global.clearDatabase ? '运行中' : '未启动'
          },
          cookiecloud: {
            exists: !!global.cookiecloud,
            status: global.cookiecloud ? '运行中' : '未启动'
          }
        }
      };
      
      res.send({
        success: true,
        data: status
      });
    } catch (e) {
      logger.error('获取定时任务状态失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 查询遗漏的聚合统计数据
  async checkMissingDailyStats (req, res) {
    try {
      const util = require('../libs/util');
      const moment = require('moment');
      
      // 获取中国时区的moment对象
      const getMomentCN = (input) => {
        if (input) {
          return moment(input).utcOffset(8 * 60); // UTC+8
        }
        return moment().utcOffset(8 * 60); // UTC+8
      };
      
      const today = getMomentCN().format('YYYY-MM-DD');
      const startDate = getMomentCN().subtract(30, 'days').format('YYYY-MM-DD');
      
      // 生成最近30天的日期列表（不包括今天）
      const dateList = [];
      for (let i = 1; i <= 30; i++) {
        const date = getMomentCN().subtract(i, 'days').format('YYYY-MM-DD');
        dateList.push(date);
      }
      
      // 查询已存在的统计记录
      const existingStats = await util.getRecords(
        'SELECT stats_date FROM daily_stats WHERE stats_date >= ? AND stats_date < ?',
        [startDate, today]
      );
      const existingDates = existingStats.map(item => item.stats_date);
      
      // 找出遗漏的日期
      const missingDates = dateList.filter(date => !existingDates.includes(date));
      
      // 按日期顺序排序（从旧到新）
      missingDates.sort();
      
      // 检查遗漏日期的种子数据情况
      const missingDateDetails = [];
      for (const date of missingDates) {
        const startTime = getMomentCN(date).startOf('day').unix();
        const endTime = getMomentCN(date).endOf('day').unix();
        const torrentCount = await util.getRecord(
          'SELECT count(*) as count FROM torrents WHERE record_time >= ? AND record_time <= ?',
          [startTime, endTime]
        );
        
        missingDateDetails.push({
          date: date,
          torrentCount: torrentCount.count,
          canAggregate: torrentCount.count > 0
        });
      }
      
      res.send({
        success: true,
        data: {
          dateRange: {
            start: startDate,
            end: today,
            totalDays: dateList.length
          },
          existing: {
            count: existingDates.length,
            dates: existingDates.sort()
          },
          missing: {
            count: missingDates.length,
            dates: missingDateDetails
          },
          summary: {
            totalDays: dateList.length,
            existingDays: existingDates.length,
            missingDays: missingDates.length,
            aggregatableDays: missingDateDetails.filter(d => d.canAggregate).length
          }
        }
      });
      
    } catch (e) {
      logger.error('查询遗漏统计数据失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 手动补充遗漏的聚合统计数据
  async backfillDailyStats (req, res) {
    try {
      const util = require('../libs/util');
      const moment = require('moment');
      
      // 获取中国时区的moment对象
      const getMomentCN = (input) => {
        if (input) {
          return moment(input).utcOffset(8 * 60); // UTC+8
        }
        return moment().utcOffset(8 * 60); // UTC+8
      };
      
      const today = getMomentCN().format('YYYY-MM-DD');
      const startDate = getMomentCN().subtract(30, 'days').format('YYYY-MM-DD');
      
      logger.info(`开始检查并补充 ${startDate} 到 ${today} 的遗漏统计数据...`);
      
      // 生成最近30天的日期列表（不包括今天）
      const dateList = [];
      for (let i = 1; i <= 30; i++) {
        const date = getMomentCN().subtract(i, 'days').format('YYYY-MM-DD');
        dateList.push(date);
      }
      
      // 查询已存在的统计记录
      const existingStats = await util.getRecords(
        'SELECT stats_date FROM daily_stats WHERE stats_date >= ? AND stats_date < ?',
        [startDate, today]
      );
      const existingDates = existingStats.map(item => item.stats_date);
      
      // 找出遗漏的日期
      const missingDates = dateList.filter(date => !existingDates.includes(date));
      
      logger.info(`发现 ${missingDates.length} 个遗漏的日期需要补充统计数据`);
      
      if (missingDates.length === 0) {
        return res.send({
          success: true,
          message: '没有发现遗漏的统计数据',
          data: {
            totalDays: dateList.length,
            existingDays: existingDates.length,
            missingDays: 0,
            missingDates: []
          }
        });
      }
      
      // 按日期顺序排序（从旧到新）
      missingDates.sort();
      
      const results = [];
      let successCount = 0;
      let failCount = 0;
      
      // 逐个处理遗漏的日期
      for (const date of missingDates) {
        try {
          logger.info(`开始补充 ${date} 的统计数据...`);
          
          // 检查该日期是否有种子数据
          const startTime = getMomentCN(date).startOf('day').unix();
          const endTime = getMomentCN(date).endOf('day').unix();
          const torrentCount = await util.getRecord(
            'SELECT count(*) as count FROM torrents WHERE record_time >= ? AND record_time <= ?',
            [startTime, endTime]
          );
          
          if (torrentCount.count === 0) {
            logger.info(`${date} 没有种子数据，跳过聚合`);
            results.push({
              date: date,
              status: 'skipped',
              reason: '无种子数据',
              torrentCount: 0
            });
            continue;
          }
          
          // 执行聚合
          await util.aggregateDailyStats(date);
          
          logger.info(`${date} 的统计数据补充完成`);
          results.push({
            date: date,
            status: 'success',
            torrentCount: torrentCount.count
          });
          successCount++;
          
        } catch (e) {
          logger.error(`补充 ${date} 的统计数据失败:`, e);
          results.push({
            date: date,
            status: 'failed',
            error: e.message
          });
          failCount++;
        }
      }
      
      const summary = {
        totalMissingDays: missingDates.length,
        successCount: successCount,
        failCount: failCount,
        skippedCount: results.filter(r => r.status === 'skipped').length
      };
      
      logger.info(`统计数据补充完成: 成功 ${successCount} 个，失败 ${failCount} 个，跳过 ${summary.skippedCount} 个`);
      
      res.send({
        success: true,
        message: `统计数据补充完成: 成功 ${successCount} 个，失败 ${failCount} 个，跳过 ${summary.skippedCount} 个`,
        data: {
          summary: summary,
          details: results,
          dateRange: {
            start: startDate,
            end: today,
            totalDays: dateList.length,
            existingDays: existingDates.length
          }
        }
      });
      
    } catch (e) {
      logger.error('补充统计数据失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 手动清理过期流量数据
  async cleanExpiredFlowData (req, res) {
    try {
      const util = require('../libs/util');
      const moment = require('moment');
      
      // 清理超过1天的 torrent_flow 数据
      const torrentFlowResult = await util.runRecord('DELETE FROM torrent_flow WHERE time < ?', [moment().unix() - 24 * 3600]);
      
      // 清理超过7天的 tracker_flow 数据
      const trackerFlowResult = await util.runRecord('DELETE FROM tracker_flow WHERE time < ?', [moment().unix() - 7 * 24 * 3600]);
      
      logger.info(`清理过期数据完成 - torrent_flow: ${torrentFlowResult.changes} 条, tracker_flow: ${trackerFlowResult.changes} 条`);
      
      res.send({
        success: true,
        message: `清理完成，已删除 ${torrentFlowResult.changes + trackerFlowResult.changes} 条过期数据`,
        data: {
          torrentFlowDeleted: torrentFlowResult.changes,
          trackerFlowDeleted: trackerFlowResult.changes
        }
      });
    } catch (e) {
      logger.error('清理过期数据失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }

  // 清理老旧种子记录
  async cleanOldTorrents (req, res) {
    try {
      const util = require('../libs/util');
      const moment = require('moment');
      const { keepMonths = 3 } = req.body;
      
      // 计算保留期限的时间戳
      const cutoffTime = moment().subtract(keepMonths, 'months').unix();
      const cutoffDate = moment(cutoffTime * 1000).format('YYYY-MM-DD HH:mm:ss');
      
      logger.info(`开始清理 ${cutoffDate} 之前的种子记录 (保留最近 ${keepMonths} 个月)`);
      
      // 删除老旧种子记录
      const result = await util.runRecord('DELETE FROM torrents WHERE record_time < ?', [cutoffTime]);
      
      logger.info(`清理老旧种子记录完成，已删除 ${result.changes} 条记录`);
      
      res.send({
        success: true,
        message: `清理完成，已删除 ${result.changes} 条老旧种子记录`,
        data: {
          deletedCount: result.changes,
          cutoffDate: cutoffDate,
          keepMonths: keepMonths
        }
      });
    } catch (e) {
      logger.error('清理老旧种子记录失败:', e);
      res.send({
        success: false,
        message: e.message
      });
    }
  }
}
module.exports = Setting;
