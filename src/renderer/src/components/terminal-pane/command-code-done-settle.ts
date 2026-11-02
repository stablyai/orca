/** Own settle deadlines across park/reveal so remounts cannot strand working rows or complete early; current pane owners retain row writes. */

// Use the same settle window mounted or parked so park/reveal cannot change completion timing.
export const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500

type CommandCodeDoneSettleExecutor = (normalizedPrompt: string) => void

const executorByPaneKey = new Map<string, CommandCodeDoneSettleExecutor>()
const timerByPaneKey = new Map<string, ReturnType<typeof setTimeout>>()

/** Last registrant wins during overlapping park/reveal handoff; return an identity-checked release. */
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

export function _resetCommandCodeDoneSettlesForTest(): void {
  for (const timer of timerByPaneKey.values()) {
    clearTimeout(timer)
  }
  timerByPaneKey.clear()
  executorByPaneKey.clear()
}
