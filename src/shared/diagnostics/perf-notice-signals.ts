/** What the perf notices read from main: in-process only, and only while a window is focused. */
export type PerfNoticeSignals = {
  disk: { freeBytes: number; totalBytes: number } | null
}
