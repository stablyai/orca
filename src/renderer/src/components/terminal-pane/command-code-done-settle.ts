/**
 * Cross-mount owner of Command Code's done-settle window.
 *
 * Why: park unmounts the pane and reveal disposes the parked watcher, both
 * possibly mid-settle, and neither successor can re-observe the idle composer
 * that opened the window. Owning the deadline here means park cannot strand the
 * row at 'working' and reveal need not complete the turn early; only the row
 * write (routing + title slot) stays with whoever currently owns the pane.
 */

// Mirrors the mounted and parked policies: the settle window must be identical
// whether the pane is mounted or parked, or park/reveal changes completion timing.
export const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500

type CommandCodeDoneSettleExecutor = (normalizedPrompt: string) => void

const executorByPaneKey = new Map<string, CommandCodeDoneSettleExecutor>()
const timerByPaneKey = new Map<string, ReturnType<typeof setTimeout>>()

/** Registers the current writer for this pane; returns its release.
 *  Last registrant wins by design: park and reveal each hand the pane to a new
 *  owner while the predecessor is still registered, so refusing the overwrite
 *  would leave the row with an owner that can no longer write it. */
export function setCommandCodeDoneSettleExecutor(
  paneKey: string,
  execute: CommandCodeDoneSettleExecutor
): () => void {
  executorByPaneKey.set(paneKey, execute)
  return () => {
    // Why identity-checked: on reveal the remounted pane registers before the parked watcher releases.
    if (executorByPaneKey.get(paneKey) === execute) {
      executorByPaneKey.delete(paneKey)
    }
  }
}

export function openCommandCodeDoneSettle(paneKey: string, normalizedPrompt: string): void {
  cancelCommandCodeDoneSettle(paneKey)
  timerByPaneKey.set(
    paneKey,
    setTimeout(() => {
      timerByPaneKey.delete(paneKey)
      // Why optional: a pane torn down with no successor has no row worth completing.
      executorByPaneKey.get(paneKey)?.(normalizedPrompt)
    }, COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)
  )
}

export function cancelCommandCodeDoneSettle(paneKey: string): void {
  const timer = timerByPaneKey.get(paneKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    timerByPaneKey.delete(paneKey)
  }
}

/** Test-only: drops every pending window so suites cannot leak timers across cases. */
export function _resetCommandCodeDoneSettlesForTest(): void {
  for (const timer of timerByPaneKey.values()) {
    clearTimeout(timer)
  }
  timerByPaneKey.clear()
  executorByPaneKey.clear()
}
