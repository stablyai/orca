import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

export type ShutdownBufferCaptureOptions = {
  includeLocalBuffers?: boolean
  /** Ordinary cold parks keep bytes in localOnlyScrollbackByTabId; rarer force-park/sleep/shutdown captures stay shared for another desktop’s cold restore. */
  localOnly?: boolean
  /** Park captures yield between panes so a 20-pane SSH hide cannot freeze a frame. */
  yieldBetweenPanes?: boolean
}

/** Mounted-tab captures for shutdown and worktree-scoped sleep; a leaf module avoids the TerminalPane → store → TerminalPane initialization cycle. */
export const shutdownBufferCaptures = new Map<
  string,
  (options?: ShutdownBufferCaptureOptions) => void | Promise<void>
>()

/** Isolate capture failures and report coverage so callers can decide whether to retry. */
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
