// Release one command’s holds together once, on answer or after 15s if call/frame never arrives, so holds cannot outlast main’s frames.

import type { WindowLayoutCommand } from './layout-apply-send'

const HOLD_TIMEOUT_MS = 15_000

/** Commands that change one tab's panes: frames wait to redraw that tab until the answer is in. */
const PANE_COMMANDS: ReadonlySet<string> = new Set<WindowLayoutCommand['type']>([
  'splitPane',
  'closePane',
  'renamePane',
  'equalizePanes',
  'movePane',
  'setPaneRatios',
  'setChatPane',
  'movePaneToNewTab'
])

export function holdsPaneTree(commandType: string): boolean {
  return PANE_COMMANDS.has(commandType)
}

export function releaseLayoutApplyHolds(
  commandType: string,
  holds: readonly ((() => void) | null)[]
): () => void {
  const held = holds.filter((hold) => hold !== null)
  let released = false
  // Defer a task: promise-resolving handlers such as drag-out act in awaiting callers’ microtasks.
  const release = (): void => {
    clearTimeout(expiry)
    if (released) {
      return
    }
    released = true
    for (const hold of held) {
      setTimeout(hold, 0)
    }
  }
  const expiry =
    held.length > 0
      ? setTimeout(() => {
          console.warn(`[layout-owner] ${commandType} hold released: no answer in 15s`)
          release()
        }, HOLD_TIMEOUT_MS)
      : undefined
  return release
}
