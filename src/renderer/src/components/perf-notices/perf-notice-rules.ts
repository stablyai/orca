import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'

const GB = 1024 ** 3
export const HIDDEN_TAB_MIN = 10
export const LOW_MEMORY_FRACTION = 0.15
export const IDLE_AGENT_MS = 2 * 60 * 60_000
export const IDLE_AGENT_MIN = 4

/** Under 10 GB, or under 5% on small disks: a large disk with plenty left is never "almost full". */
export function isDiskAlmostFull(signals: PerfNoticeSignals): boolean {
  const disk = signals.disk
  return !!disk && disk.totalBytes > 0 && disk.freeBytes < Math.min(10 * GB, disk.totalBytes * 0.05)
}
