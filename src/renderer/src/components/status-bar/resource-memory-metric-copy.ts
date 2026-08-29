import type { ProcessMemoryMetric } from '../../../../shared/process-stats-types'
import { translate } from '@/i18n/i18n'
import { usageTextColorClass } from './usage-roster-formatting'

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
        'Summed working set (WS): pages resident in RAM right now. Shared pages can appear in more than one process, and memory Windows has paged out is not counted here.'
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

/** No column of its own yet, so no `columnLabel`: the commit figure is a summary + tooltip. */
export function getResourceCommitMetricCopy(): Omit<ResourceMemoryMetricCopy, 'columnLabel'> {
  return {
    summaryLabel: 'Σ Private',
    description: translate(
      'auto.components.status.bar.resource.memory.metric.privateBytesDescription',
      'Summed private bytes: memory these processes have committed, counted whether it is resident or paged out. This is what the host charges against its commit limit, so it keeps rising while the working set above shrinks under paging.'
    )
  }
}

/**
 * Warning tint once *Orca's own* tracked commit grows large against physical
 * RAM, on the same 60/80 bands as the host usage bars. Deliberately not a
 * host-wide paging predictor: that needs the host's commit charge and commit
 * limit, which this snapshot does not carry (#16211).
 *
 * Null both when the share is unremarkable and when the snapshot has no commit
 * figure at all — silence is the honest answer for an unmeasured host.
 */
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
  const tone = usageTextColorClass((privateMemory / hostTotalMemory) * 100)
  return tone === 'text-foreground' ? null : tone
}
