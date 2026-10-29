export type ShutdownBufferCaptureOptions = {
  includeLocalBuffers?: boolean
  /** Ordinary cold parks keep bytes in localOnlyScrollbackByTabId; rarer force-park/sleep/shutdown captures stay shared for another desktop’s cold restore. */
  localOnly?: boolean
}

/** Mounted-tab captures for shutdown and worktree-scoped sleep; a leaf module avoids the TerminalPane → store → TerminalPane initialization cycle. */
export const shutdownBufferCaptures = new Map<
  string,
  (options?: ShutdownBufferCaptureOptions) => void
>()

/** Isolate capture failures and report coverage so callers can decide whether to retry. */
export function captureTerminalShutdownBuffersBestEffort(
  tabIds: readonly string[],
  options?: ShutdownBufferCaptureOptions
): { requested: number; captured: number } {
  let captured = 0
  for (const tabId of tabIds) {
    const capture = shutdownBufferCaptures.get(tabId)
    if (!capture) {
      continue
    }
    try {
      capture(options)
      captured += 1
    } catch {
      // Buffer capture is optional recovery evidence; parking must still commit.
    }
  }
  return { requested: tabIds.length, captured }
}
