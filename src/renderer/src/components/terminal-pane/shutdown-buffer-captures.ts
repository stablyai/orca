import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

export type ShutdownBufferCaptureOptions = {
  includeLocalBuffers?: boolean
  /** Park captures yield between panes so a 20-pane SSH hide cannot freeze a frame. */
  yieldBetweenPanes?: boolean
}

/** Map of tabId → buffer-capture callback, one per mounted TerminalPane.
 *  The beforeunload handler in App.tsx invokes every callback to populate
 *  Zustand with serialized buffers before flushing the session to disk.
 *  Sleep (shutdownWorktreeTerminals with keepIdentifiers: true) iterates
 *  only the entries whose tabId belongs to the worktree being slept, so
 *  SSH worktrees can capture scrollback before the relay SIGKILLs the
 *  remote PTY — see DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
 *
 *  Why this lives in its own module: the registry is shared between
 *  TerminalPane.tsx (registration site) and the terminals store slice
 *  (sleep-time iteration). Importing it directly from TerminalPane would
 *  create a cycle (slice → TerminalPane → store → slice) that breaks the
 *  Zustand store at module-init time. */
export const shutdownBufferCaptures = new Map<
  string,
  (options?: ShutdownBufferCaptureOptions) => void | Promise<void>
>()

/** Capture every mounted tab without letting one layout failure abort retention.
 *  Reports coverage so a caller can decide whether the episode is retryable. */
export function captureTerminalShutdownBuffersBestEffort(
  tabIds: readonly string[],
  options: ShutdownBufferCaptureOptions & { yieldBetweenPanes: true }
): Promise<{ requested: number; captured: number }>
export function captureTerminalShutdownBuffersBestEffort(
  tabIds: readonly string[],
  options?: ShutdownBufferCaptureOptions
): { requested: number; captured: number }
export function captureTerminalShutdownBuffersBestEffort(
  tabIds: readonly string[],
  options?: ShutdownBufferCaptureOptions
): { requested: number; captured: number } | Promise<{ requested: number; captured: number }> {
  if (options?.yieldBetweenPanes) {
    return captureTerminalShutdownBuffersYielding(tabIds, options)
  }
  return captureTerminalShutdownBuffersSync(tabIds, options)
}

function captureTerminalShutdownBuffersSync(
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

async function captureTerminalShutdownBuffersYielding(
  tabIds: readonly string[],
  options: ShutdownBufferCaptureOptions
): Promise<{ requested: number; captured: number }> {
  let captured = 0
  for (let index = 0; index < tabIds.length; index += 1) {
    if (index > 0) {
      await yieldToEventLoop()
    }
    const tabId = tabIds[index]
    const capture = shutdownBufferCaptures.get(tabId)
    if (!capture) {
      continue
    }
    try {
      await capture(options)
      captured += 1
    } catch {
      // Buffer capture is optional recovery evidence; parking must still commit.
    }
  }
  return { requested: tabIds.length, captured }
}
