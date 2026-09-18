import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  isDocumentBodyOrNull,
  scheduleNextFrame,
  type TerminalImeInputContextRefocusScheduler
} from './terminal-ime-input-context-refresh'

export type ReclaimTerminalPaneFocusOptions = {
  scheduleRefocus?: TerminalImeInputContextRefocusScheduler
}

/**
 * Reclaims focus for a terminal pane after a context menu close or right-click gesture,
 * ensuring focus is never stolen from an active control the user legitimately clicked.
 */
export function reclaimTerminalPaneFocus(
  pane: Pick<ManagedPane, 'container' | 'terminal'> | null | undefined,
  options?: ReclaimTerminalPaneFocusOptions
): void {
  if (!pane) {
    return
  }
  const schedule = options?.scheduleRefocus ?? scheduleNextFrame
  schedule(() => {
    const container = pane.container
    if (!container.isConnected) {
      return
    }
    const doc = container.ownerDocument ?? document
    const active = doc.activeElement
    // Guard: only reclaim when activeElement is document.body or inside this pane's container.
    // A rename input, another pane, or a dialog button clicked in the meantime is neither,
    // so focus is not stolen.
    if (isDocumentBodyOrNull(active, doc) || container.contains(active)) {
      pane.terminal.focus()
    }
  })
}
