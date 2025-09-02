<template>
  <div class="data-management">
    <a-card title="数据管理" :bordered="false">
      <div class="management-sections">
        
        <!-- 定时任务状态监控 -->
        <a-card size="small" title="📊 定时任务状态" class="section-card">
          <div class="action-group">
            <a-button type="primary" @click="getCronStatus" :loading="loadingStatus.cronStatus">
              <a-icon type="clock-circle" />
              查询定时任务状态
            </a-button>
          </div>
          <div v-if="cronStatus" class="status-display">
            <a-descriptions size="small" :column="2" bordered>
              <a-descriptions-item label="系统时间">{{ cronStatus.systemTime }}</a-descriptions-item>
              <a-descriptions-item label="中国时间">{{ cronStatus.chinaTime }}</a-descriptions-item>
              <a-descriptions-item label="时区">{{ cronStatus.timezone }}</a-descriptions-item>
              <a-descriptions-item label="每日统计聚合">
                <a-tag :color="cronStatus.tasks?.dailyStatsAggregation?.exists ? 'green' : 'red'">
                  {{ cronStatus.tasks?.dailyStatsAggregation?.status || '未知' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="数据库清理">
                <a-tag :color="cronStatus.tasks?.clearDatabase?.exists ? 'green' : 'red'">
                  {{ cronStatus.tasks?.clearDatabase?.status || '未知' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="CookieCloud">
                <a-tag :color="cronStatus.tasks?.cookiecloud?.exists ? 'green' : 'red'">
                  {{ cronStatus.tasks?.cookiecloud?.status || '未知' }}
                </a-tag>
              </a-descriptions-item>
            </a-descriptions>
          </div>
        </a-card>

        <!-- 每日统计管理 -->
        <a-card size="small" title="📈 每日统计管理" class="section-card">
          <div class="action-group">
            <a-button type="primary" @click="testDailyStatsTask" :loading="loadingStatus.dailyStats">
              <a-icon type="play-circle" />
              手动触发每日聚合
            </a-button>
            <a-button @click="checkMissingDailyStats" :loading="loadingStatus.checkMissing">
              <a-icon type="search" />
              检查遗漏统计
            </a-button>
            <a-button type="dashed" @click="backfillDailyStats" :loading="loadingStatus.backfill">
              <a-icon type="sync" />
              补充遗漏数据
            </a-button>
          </div>
          <div v-if="missingStats" class="missing-stats-display">
            <a-alert
              :message="`发现 ${missingStats.missing?.count || 0} 天缺失统计数据`"
              :description="`统计范围：${missingStats.dateRange?.start} 至 ${missingStats.dateRange?.end}，已存在 ${missingStats.existing?.count || 0} 天数据`"
              type="info"
              show-icon
            />
            <div v-if="missingStats.missing?.dates?.length > 0" class="missing-dates">
              <h4>缺失日期详情：</h4>
              <a-table
                :columns="missingDateColumns"
                :data-source="missingStats.missing.dates"
                :pagination="false"
                size="small"
              />
            </div>
          </div>
        </a-card>

        <!-- 数据清理 -->
        <a-card size="small" title="🧹 数据清理" class="section-card">
          <div class="action-group">
            <a-button type="danger" @click="showClearHistoryModal">
              <a-icon type="delete" />
              清理所有历史记录
            </a-button>
            <a-button @click="cleanExpiredFlowData" :loading="loadingStatus.cleanFlow">
              <a-icon type="sweep" />
              清理过期流量数据
            </a-button>
            <a-button @click="showCleanTorrentsModal">
              <a-icon type="file-protect" />
              清理老旧种子记录
            </a-button>
          </div>
        </a-card>

      </div>
    </a-card>

    <!-- 清理历史记录确认弹窗 -->
    <a-modal
      title="⚠️ 危险操作确认"
      :visible="clearHistoryVisible"
      @ok="confirmClearHistory"
      @cancel="clearHistoryVisible = false"
      :confirm-loading="loadingStatus.clearHistory"
      ok-text="确认删除"
      cancel-text="取消"
      ok-type="danger"
    >
      <a-alert
        message="此操作将永久删除所有历史数据！"
        description="包括：站点数据、种子流量记录、种子记录、Tracker流量记录、网络统计数据。此操作不可恢复，请谨慎操作。"
        type="error"
        show-icon
      />
      <div style="margin-top: 16px;">
        <p>请输入 <strong>DELETE</strong> 确认删除：</p>
        <a-input v-model="deleteConfirmText" placeholder="请输入 DELETE" />
      </div>
    </a-modal>

    <!-- 清理老旧种子记录弹窗 -->
    <a-modal
      title="清理老旧种子记录"
      :visible="cleanTorrentsVisible"
      @ok="confirmCleanTorrents"
      @cancel="cleanTorrentsVisible = false"
      :confirm-loading="loadingStatus.cleanTorrents"
      ok-text="开始清理"
      cancel-text="取消"
    >
      <p>选择要保留的时间范围，更早的种子记录将被删除：</p>
      <a-radio-group v-model="keepMonths">
        <a-radio :value="1">保留最近 1 个月</a-radio>
        <a-radio :value="2">保留最近 2 个月</a-radio>
        <a-radio :value="3">保留最近 3 个月</a-radio>
        <a-radio :value="6">保留最近 6 个月</a-radio>
        <a-radio :value="12">保留最近 1 年</a-radio>
      </a-radio-group>
      <a-alert
        style="margin-top: 16px;"
        message="注意"
        description="由于已有每日聚合统计数据，删除老旧种子记录不会影响历史统计信息。"
        type="info"
        show-icon
      />
    </a-modal>
  </div>
</template>

<script>
import settingApi from '../../api/setting';

export default {
  name: 'DataManagement',
  data() {
    return {
      cronStatus: null,
      missingStats: null,
      clearHistoryVisible: false,
      cleanTorrentsVisible: false,
      deleteConfirmText: '',
      keepMonths: 3,
      loadingStatus: {
        cronStatus: false,
        dailyStats: false,
        checkMissing: false,
        backfill: false,
        clearHistory: false,
        cleanFlow: false,
        cleanTorrents: false
      },
      missingDateColumns: [
        {
          title: '日期',
          dataIndex: 'date',
          key: 'date',
          width: 120
        },
        {
          title: '种子数量',
          dataIndex: 'torrentCount',
          key: 'torrentCount',
          width: 100
        },
        {
          title: '是否可聚合',
          dataIndex: 'canAggregate',
          key: 'canAggregate',
          width: 120,
          render: (canAggregate) => (
            <a-tag color={canAggregate ? 'green' : 'orange'}>
              {canAggregate ? '是' : '否'}
            </a-tag>
          )
        }
      ]
    };
  },
  methods: {
    async getCronStatus() {
      this.loadingStatus.cronStatus = true;
      try {
        const res = await settingApi.getCronStatus();
        if (res.success) {
          this.cronStatus = res.data;
          this.$message.success('定时任务状态查询成功');
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('查询失败: ' + error.message);
      } finally {
        this.loadingStatus.cronStatus = false;
      }
    },

    async testDailyStatsTask() {
      this.loadingStatus.dailyStats = true;
      try {
        const res = await settingApi.testDailyStatsTask();
        if (res.success) {
          this.$message.success('每日统计聚合任务执行成功');
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('执行失败: ' + error.message);
      } finally {
        this.loadingStatus.dailyStats = false;
      }
    },

    async checkMissingDailyStats() {
      this.loadingStatus.checkMissing = true;
      try {
        const res = await settingApi.checkMissingDailyStats();
        if (res.success) {
          this.missingStats = res.data;
          this.$message.success(`检查完成，发现 ${res.data.missing?.count || 0} 天缺失数据`);
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('检查失败: ' + error.message);
      } finally {
        this.loadingStatus.checkMissing = false;
      }
    },

    async backfillDailyStats() {
      this.loadingStatus.backfill = true;
      try {
        const res = await settingApi.backfillDailyStats();
        if (res.success) {
          this.$message.success(res.message);
          // 重新检查遗漏数据
          this.checkMissingDailyStats();
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('补充失败: ' + error.message);
      } finally {
        this.loadingStatus.backfill = false;
      }
    },

    showClearHistoryModal() {
      this.clearHistoryVisible = true;
      this.deleteConfirmText = '';
    },

    async confirmClearHistory() {
      if (this.deleteConfirmText !== 'DELETE') {
        this.$message.error('请输入 DELETE 确认删除');
        return;
      }

      this.loadingStatus.clearHistory = true;
      try {
        const res = await settingApi.clearHistory();
        if (res.success) {
          this.$message.success('历史数据清理成功');
          this.clearHistoryVisible = false;
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('清理失败: ' + error.message);
      } finally {
        this.loadingStatus.clearHistory = false;
      }
    },

    async cleanExpiredFlowData() {
      this.loadingStatus.cleanFlow = true;
      try {
        const res = await settingApi.cleanExpiredFlowData();
        if (res.success) {
          this.$message.success(res.message);
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('清理失败: ' + error.message);
      } finally {
        this.loadingStatus.cleanFlow = false;
      }
    },

    showCleanTorrentsModal() {
      this.cleanTorrentsVisible = true;
    },

    async confirmCleanTorrents() {
      this.loadingStatus.cleanTorrents = true;
      try {
        const res = await settingApi.cleanOldTorrents(this.keepMonths);
        if (res.success) {
          this.$message.success(res.message);
          this.cleanTorrentsVisible = false;
        } else {
          this.$message.error(res.message);
        }
      } catch (error) {
        this.$message.error('清理失败: ' + error.message);
      } finally {
        this.loadingStatus.cleanTorrents = false;
      }
    }
  },

  mounted() {
    this.getCronStatus();
    this.checkMissingDailyStats();
  }
};
</script>

<style scoped>
.data-management {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.management-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section-card {
  margin-bottom: 0;
}

.action-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.status-display {
  margin-top: 16px;
  padding: 16px;
  background-color: #fafafa;
  border-radius: 6px;
}

.missing-stats-display {
  margin-top: 16px;
}

.missing-dates {
  margin-top: 12px;
}

.missing-dates h4 {
  margin-bottom: 8px;
  color: #1890ff;
}

@media (max-width: 768px) {
  .data-management {
    padding: 10px;
  }
  
  .action-group {
    flex-direction: column;
  }
  
  .action-group .ant-btn {
    width: 100%;
  }
}
</style>
