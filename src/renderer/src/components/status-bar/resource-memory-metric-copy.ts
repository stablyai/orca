import type { ProcessMemoryMetric } from '../../../../shared/process-stats-types'
import { translate } from '@/i18n/i18n'

export type ResourceMemoryMetricCopy = {
  columnLabel: string
  summaryLabel: string
  description: string
}

export function getResourceMemoryMetricCopy(metric: ProcessMemoryMetric): ResourceMemoryMetricCopy {
  if (metric === 'working-set') {
    return {
      columnLabel: 'WS',
      summaryLabel: 'Σ WS',
      description: translate(
        'auto.components.status.bar.resource.memory.metric.workingSetDescription',
        'Summed working set (WS). Shared pages can appear in more than one process.'
      )
    }
  }
  return {
    columnLabel: 'RSS',
    summaryLabel: 'Σ RSS',
    description: translate(
      'auto.components.status.bar.resource.memory.metric.rssDescription',
      'Summed resident set size (RSS). Shared or aliased pages can appear in more than one process.'
    )
  }
}
