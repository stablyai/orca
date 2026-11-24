import type { ProcessMemoryMetric } from '../../../../../../shared/diagnostics/process-stats-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type ResourceMemoryMetricCopy = {
  columnLabel: string
  summaryLabel: string
}

export function getResourceMemoryMetricCopy(
  metric: ProcessMemoryMetric,
  t: Translate = translate
): ResourceMemoryMetricCopy {
  if (metric === 'footprint') {
    return {
      columnLabel: t('auto.components.status.bar.resource.memory.metric.memColumn', 'Mem'),
      summaryLabel: t('auto.components.status.bar.resource.memory.metric.memorySummary', 'Σ Memory')
    }
  }
  if (metric === 'working-set') {
    return {
      columnLabel: 'WS',
      summaryLabel: 'Σ WS'
    }
  }
  return {
    columnLabel: 'RSS',
    summaryLabel: 'Σ RSS'
  }
}

/** Tint Orca’s tracked commit share of physical RAM; missing host commit charge/limit prevents predicting system-wide paging. */
export function getCommitPressureToneClass(args: {
  privateMemory: number | undefined
  hostTotalMemory: number
}): string | null {
  const { privateMemory, hostTotalMemory } = args
  if (typeof privateMemory !== 'number' || !Number.isFinite(privateMemory)) {
    return null
  }
  if (!Number.isFinite(hostTotalMemory) || hostTotalMemory <= 0) {
    return null
  }
  // Uncapped on purpose: commit past 100% of RAM is the loudest case, not an error.
  const tone = memoryPressureTextClass((privateMemory / hostTotalMemory) * 100)
  return tone === 'text-foreground' ? null : tone
}

// Memory pressure stays neutral until 60% so healthy hosts never read as alarming.
function memoryPressureTextClass(usedPercent: number): string {
  if (usedPercent >= 80) {
    return 'text-red-500'
  }
  if (usedPercent >= 60) {
    return 'text-yellow-500'
  }
  return 'text-foreground'
}
