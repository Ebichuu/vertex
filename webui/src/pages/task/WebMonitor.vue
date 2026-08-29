<template>
  <div style="font-size: 24px; font-weight: bold;">网页监控</div>
  <a-divider></a-divider>
  <div class="web-monitor">
    <a-alert
      message="网页监控负责快速发现，RSS 继续作为兜底"
      description="两个来源使用站点域名和种子 ID 统一去重；成功添加后不会重复进种，添加失败仍允许另一个来源重试。"
      type="info"
      show-icon
      style="margin-bottom: 16px"/>
    <a-table :columns="columns" :data-source="monitorList" size="small" :pagination="false" :scroll="{ x: 900 }">
      <template #title><span style="font-size: 16px; font-weight: bold;">网页监控列表</span></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'enable'">
          <a-switch @change="enableTask(record)" v-model:checked="record.enable" checked-children="启用" un-checked-children="禁用"/>
        </template>
        <template v-if="column.dataIndex === 'interval'">{{ record.minIntervalSeconds }}–{{ record.maxIntervalSeconds }} 秒</template>
        <template v-if="column.dataIndex === 'status'">
          <a-tag v-if="record.status && record.status.lastError" color="error">异常</a-tag>
          <a-tag v-else-if="record.status && record.status.running" color="success">运行中</a-tag>
          <a-tag v-else>未运行</a-tag>
          <span v-if="record.status && record.status.lastError" style="color: #ff4d4f; margin-left: 6px;">{{ record.status.lastError }}</span>
        </template>
        <template v-if="column.dataIndex === 'lastSuccessTime'">
          {{ record.status && record.status.lastSuccessTime ? $moment(record.status.lastSuccessTime * 1000).format('YYYY-MM-DD HH:mm:ss') : '-' }}
        </template>
        <template v-if="column.title === '操作'">
          <a @click="modifyClick(record)">编辑</a>
          <a-divider type="vertical"/>
          <a-popconfirm title="确认删除该网页监控吗？" @confirm="deleteMonitor(record)">
            <a style="color: red">删除</a>
          </a-popconfirm>
        </template>
      </template>
    </a-table>
    <a-divider></a-divider>
    <div style="font-size: 16px; font-weight: bold; padding-left: 8px;">新增 | 编辑网页监控</div>
    <a-form
      labelAlign="right"
      :labelWrap="true"
      :model="monitor"
      size="small"
      @finish="modifyMonitor"
      :labelCol="{ span: 4 }"
      :wrapperCol="{ span: 20 }"
      autocomplete="off">
      <a-form-item label="别名" name="alias" extra="例如 CHD 网页监控" :rules="[{ required: true, message: '别名不可为空' }]">
        <a-input v-model:value="monitor.alias"/>
      </a-form-item>
      <a-form-item label="启用" name="enable"><a-checkbox v-model:checked="monitor.enable">启用</a-checkbox></a-form-item>
      <a-form-item label="站点解析器" name="parserType" :rules="[{ required: true }]">
        <a-select v-model:value="monitor.parserType" style="width: 220px"><a-select-option value="chd">CHD</a-select-option></a-select>
      </a-form-item>
      <a-form-item label="种子页面" name="pageUrl" extra="自动按发布时间读取最新列表" :rules="[{ required: true, message: '页面地址不可为空' }]">
        <a-input v-model:value="monitor.pageUrl"/>
      </a-form-item>
      <a-form-item label="监控页数" name="pageCount" extra="CHD 第一页有大量置顶官种，默认读取前两页以覆盖普通种">
        <a-input type="number" min="1" max="5" v-model:value="monitor.pageCount" style="width: 220px"><template #addonAfter>页</template></a-input>
      </a-form-item>
      <a-form-item label="登录 Cookie" name="cookie" extra="仅用于读取种子页面和下载种子文件，不会交给下载器" :rules="[{ required: true, message: 'Cookie 不可为空' }]">
        <a-input-password v-model:value="monitor.cookie"/>
      </a-form-item>
      <a-form-item label="目标共享源" name="targetSharedSource" extra="填写现有 RSS 分流使用的共享源标识，例如 CHD" :rules="[{ required: true, message: '目标共享源不可为空' }]">
        <a-input v-model:value="monitor.targetSharedSource" style="width: 220px"/>
      </a-form-item>
      <a-form-item label="随机等待" extra="每轮完成后，在最短与最长秒数之间随机等待；推荐 11–61 秒">
        <a-input-group compact>
          <a-input type="number" min="1" max="86400" v-model:value="monitor.minIntervalSeconds" style="width: 150px"><template #addonAfter>最短秒数</template></a-input>
          <a-input type="number" min="1" max="86400" v-model:value="monitor.maxIntervalSeconds" style="width: 150px"><template #addonAfter>最长秒数</template></a-input>
        </a-input-group>
      </a-form-item>
      <a-form-item label="最长休眠时间" name="maxSleepTime" extra="监控中断超过此时间时只重建基线；首次发现时已超过此发布时间的种子也会忽略，建议不低于 600 秒">
        <a-input type="number" min="1" max="86400" v-model:value="monitor.maxSleepTime" style="width: 220px"><template #addonAfter>秒</template></a-input>
      </a-form-item>
      <a-form-item :wrapperCol="{ span: 20, offset: 4 }">
        <a-button type="primary" html-type="submit">应用 | 完成</a-button>
        <a-button style="margin-left: 12px" @click="clearMonitor">清空</a-button>
      </a-form-item>
    </a-form>
  </div>
</template>

<script>
export default {
  data () {
    return {
      columns: [
        { title: '别名', dataIndex: 'alias', width: 28 },
        { title: '启用', dataIndex: 'enable', width: 18 },
        { title: '随机间隔', dataIndex: 'interval', width: 24 },
        { title: '目标共享源', dataIndex: 'targetSharedSource', width: 24 },
        { title: '状态', dataIndex: 'status', width: 50 },
        { title: '最近成功', dataIndex: 'lastSuccessTime', width: 34 },
        { title: '操作', width: 24 }
      ],
      monitorList: [],
      monitor: {},
      defaultMonitor: {
        alias: 'CHD 网页监控',
        enable: false,
        parserType: 'chd',
        pageUrl: 'https://ptchdbits.co/torrents.php',
        pageCount: 2,
        cookie: '',
        targetSharedSource: 'CHD',
        minIntervalSeconds: 11,
        maxIntervalSeconds: 61,
        maxSleepTime: 600
      }
    };
  },
  methods: {
    async listMonitor () {
      try {
        this.monitorList = (await this.$api().webMonitor.list()).data;
      } catch (error) {
        this.$message().error(error.message);
      }
    },
    async modifyMonitor () {
      const min = Number(this.monitor.minIntervalSeconds);
      const max = Number(this.monitor.maxIntervalSeconds);
      const pageCount = Number(this.monitor.pageCount);
      const maxSleepTime = Number(this.monitor.maxSleepTime);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 86400) {
        return this.$message().error('随机等待范围无效');
      }
      if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 5) {
        return this.$message().error('监控页数必须是 1 到 5 之间的整数');
      }
      if (!Number.isInteger(maxSleepTime) || maxSleepTime < 1 || maxSleepTime > 86400) {
        return this.$message().error('最长休眠时间必须是 1 到 86400 之间的整数');
      }
      try {
        await this.$api().webMonitor.modify({ ...this.monitor, minIntervalSeconds: min, maxIntervalSeconds: max, pageCount, maxSleepTime });
        this.$message().success((this.monitor.id ? '编辑' : '新增') + '成功');
        this.clearMonitor();
        await this.listMonitor();
      } catch (error) {
        this.$message().error(error.message);
      }
    },
    async enableTask (record) {
      try {
        await this.$api().webMonitor.modify({ ...record });
        await this.listMonitor();
      } catch (error) {
        record.enable = !record.enable;
        this.$message().error(error.message);
      }
    },
    modifyClick (record) {
      this.monitor = JSON.parse(JSON.stringify(record));
      delete this.monitor.status;
    },
    async deleteMonitor (record) {
      try {
        await this.$api().webMonitor.delete(record.id);
        this.$message().success('删除成功');
        await this.listMonitor();
      } catch (error) {
        this.$message().error(error.message);
      }
    },
    clearMonitor () {
      this.monitor = { ...this.defaultMonitor };
    }
  },
  async mounted () {
    this.clearMonitor();
    await this.listMonitor();
  }
};
</script>

<style scoped>
.web-monitor {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
</style>
