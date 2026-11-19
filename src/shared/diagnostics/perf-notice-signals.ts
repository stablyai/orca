/** Cheap host readings behind the perf toasts; null means unknown on this host, never zero. */
export type PerfNoticeSignals = {
  userIdleSeconds: number
  memory: { totalMemory: number; availableMemory: number } | null
  disk: { freeBytes: number; totalBytes: number } | null
  /** Browser pages still loaded after 4 h hidden. */
  hiddenBrowserPages: number
}
