<template>
  <div style="font-size: 24px; font-weight: bold;">RSS 历史</div>
  <a-divider></a-divider>
  <div class="rss" >
    <div class="filter-bar">
      <a-select
        v-model:value="qs.rss"
        show-search
        allow-clear
        size="small"
        style="width: 200px;"
        placeholder="筛选 RSS 任务"
        option-filter-prop="label"
        :options="rssOptions"
      ></a-select>
      <a-input style="width: 180px;" size="small" placeholder="种子名称/记录关键词" v-model:value="qs.key"></a-input>
      <a-select
        v-model:value="qs.recordType"
        allow-clear
        size="small"
        style="width: 140px;"
        placeholder="种子状态"
        :options="statusOptions"
      ></a-select>
      <a-range-picker
        v-model:value="timeRange"
        size="small"
        style="width: 340px;"
        :show-time="{ hideDisabledOptions: true }"
        format="YYYY-MM-DD HH:mm"
        :placeholder="['记录开始时间', '记录结束时间']"
        :disabled-date="(current) => current && current > $moment().endOf('day')"
      />
      <a-button @click="resetFilter" size="small">重置</a-button>
      <a-button @click="() => { qs.page = 1; listHistory(); }" type="primary" size="small">筛选</a-button>
    </div>
    <a-table
      :style="`font-size: ${isMobile() ? '12px': '14px'}; margin-top: 12px;`"
      :columns="columns"
      size="small"
      :loading="loading"
      :data-source="torrents"
      :pagination="pagination"
      @change="handleChange"
      :scroll="{ x: 1040 }"
    >
      <template #title>
        <span style="font-size: 16px; font-weight: bold;">RSS 历史</span>
        <span style="font-size: 14px; font-weight: bold; color: red; margin-left: 12px;">遇到问题先去看 Wiki，特别是 Wiki 里的常见问题, 实在找不到再去交流群问, 别 TM Wiki 不看直接在群里问。</span>
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'rssId'">
          {{ (rssList.filter(item => item.id === record.rssId)[0] || { alias: '已删除' }).alias }}
        </template>
        <template v-if="column.dataIndex === 'clientId'">
          <a v-if="record.clientId" @click="gotoClient(record.clientId)">{{ record.clientId }}</a>
          <span v-else>-</span>
        </template>
        <template v-if="column.dataIndex === 'sourceType'">
          <a-tag :color="record.sourceType === 'web' ? 'processing' : 'default'">
            {{ record.sourceType === 'web' ? '网页监控' : 'RSS' }}
          </a-tag>
        </template>
        <template v-if="['size', 'upload', 'download'].indexOf(column.dataIndex) !== -1">
          {{ $formatSize(record[column.dataIndex]) }}
        </template>
        <template v-if="['recordTime', 'deleteTime'].indexOf(column.dataIndex) !== -1 && record[column.dataIndex]">
          {{ $moment(record[column.dataIndex] * 1000).format('YYYY-MM-DD HH:mm:ss') }}
        </template>
        <template v-if="column.dataIndex === 'recordNote'">
          <span>{{ record.recordNote.indexOf('wish') !== -1 ? '豆瓣' : record.recordNote }}</span>
        </template>
        <template v-if="column.title === '操作'">
          <a @click="gotoDetail(record)">打开</a>
          <a-divider type="vertical" />
          <a-popover title="删除?" trigger="click" :overlayStyle="{ width: '84px', overflow: 'hidden' }">
            <template #content>
              <a-button type="primary" danger @click="delRecord(record)" size="small">删除</a-button>
            </template>
            <a style="color: red">删除</a>
          </a-popover>
        </template>
      </template>
    </a-table>
  </div>
</template>
<script>
export default {
  data () {
    const columns = [
      {
        title: 'RSS',
        dataIndex: 'rssId',
        width: 18,
        fixed: true
      }, {
        title: '来源',
        dataIndex: 'sourceType',
        width: 20
      }, {
        title: '客户端',
        dataIndex: 'clientId',
        width: 24
      }, {
        title: '种子名称',
        dataIndex: 'name',
        width: 120
      }, {
        title: '种子大小',
        dataIndex: 'size',
        width: 24
      }, {
        title: '上传流量',
        dataIndex: 'upload',
        width: 24
      }, {
        title: '下载流量',
        dataIndex: 'download',
        width: 24
      }, {
        title: '记录时间',
        dataIndex: 'recordTime',
        width: 32
      }, {
        title: '删除时间',
        dataIndex: 'deleteTime',
        width: 32
      }, {
        title: '种子状态',
        dataIndex: 'recordNote',
        width: 32
      }, {
        title: '操作',
        dataIndex: 'option',
        width: 32
      }
    ];
    const qs = {
      page: 1,
      length: 20,
      type: 'rss',
      rss: undefined,
      key: '',
      recordType: undefined,
      startTime: '',
      endTime: ''
    };
    const pagination = {
      position: ['topRight', 'bottomRight'],
      total: 0,
      pageSize: qs.length,
      showSizeChanger: false
    };
    return {
      loading: true,
      pagination,
      columns,
      qs,
      torrents: [],
      rssList: [],
      rssOptions: [],
      statusOptions: [
        { label: '已添加', value: 1 },
        { label: '已拒绝', value: 2 },
        { label: '添加失败', value: 3 }
      ],
      timeRange: null
    };
  },
  methods: {
    isMobile () {
      if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        return true;
      } else {
        return false;
      }
    },
    buildQuery () {
      const params = {
        page: this.qs.page,
        length: this.qs.length,
        type: this.qs.type,
        rss: this.qs.rss || '',
        key: this.qs.key || '',
        recordType: this.qs.recordType || '',
        startTime: '',
        endTime: ''
      };
      if (this.timeRange && this.timeRange.length === 2 && this.timeRange[0] && this.timeRange[1]) {
        // RangePicker 返回 dayjs 对象, 兼容其在无 .unix() 时退化为 moment/Date
        const start = this.timeRange[0];
        const end = this.timeRange[1];
        params.startTime = typeof start.unix === 'function' ? start.unix() : this.$moment(start).unix();
        params.endTime = typeof end.unix === 'function' ? end.unix() : this.$moment(end).unix();
      }
      return params;
    },
    async listHistory () {
      this.loading = true;
      try {
        const res = (await this.$api().torrent.listHistory(this.buildQuery())).data;
        this.torrents = res.torrents;
        this.pagination.total = res.total;
      } catch (e) {
        await this.$message().error(e.message);
      }
      this.loading = false;
    },
    async listRss () {
      try {
        const res = await this.$api().rss.list();
        this.rssList = res.data;
        this.rssOptions = [
          ...this.rssList.map(item => ({ label: item.alias, value: item.id })),
          { label: '已删除', value: 'deleted' }
        ];
      } catch (e) {
        this.$message().error(e.message);
      }
    },
    async gotoDetail (record) {
      if (!record.link) return await this.$message().error('链接不存在');
      window.open(record.link);
    },
    async gotoClient (clientId) {
      if (!clientId) return;
      window.open(`/proxy/client/${clientId}/`);
    },
    async handleChange (pagination) {
      this.qs.page = pagination.current;
      this.listHistory();
    },
    resetFilter () {
      this.qs.rss = undefined;
      this.qs.key = '';
      this.qs.recordType = undefined;
      this.timeRange = null;
      this.qs.page = 1;
      this.listHistory();
    },
    async delRecord (record) {
      try {
        await this.$api().rss.delRecord({ id: record.id });
        this.$message().success('删除成功, 列表刷新中....');
        this.listHistory();
      } catch (e) {
        await this.$message().error(e.message);
      }
    }
  },
  async mounted () {
    this.listHistory();
    this.listRss();
  }
};
</script>
<style scoped>
.rss {
  height: calc(100% - 92px);
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
</style>
