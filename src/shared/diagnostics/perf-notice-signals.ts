/** What the perf notices read from main: in-process only, and only while a window is focused. */
export type PerfNoticeSignals = {
  disk: PerfNoticeDisk | null
}

export type PerfNoticeDisk = { freeBytes: number; totalBytes: number }

const GB = 1024 ** 3

/** Under 10 GB, or under 5% on small disks: a large disk with plenty left is never "almost full". */
export function isDiskAlmostFull(disk: PerfNoticeDisk | null): boolean {
  return !!disk && disk.totalBytes > 0 && disk.freeBytes < Math.min(10 * GB, disk.totalBytes * 0.05)
}
