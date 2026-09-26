import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  getTerminalPtyOwnershipIdentity,
  hasTerminalPtyOwnerOutsidePane,
  type TerminalTabRetirementState
} from '@/store/slices/terminal-tab-retirement'

// Why: moving a live pane into or out of the Agents view remounts TerminalPane.
// Keep session-only zoom by durable leaf ID so that UI move does not reset it.
const fontSizeByLeafId = new Map<TerminalLeafId, number>()

export function hydrateTerminalFontSizeOverride(
  pane: { id: number; leafId: TerminalLeafId },
  paneFontSizes: Map<number, number>
): void {
  const fontSize = fontSizeByLeafId.get(pane.leafId)
  if (fontSize === undefined) {
    paneFontSizes.delete(pane.id)
    return
  }
  paneFontSizes.set(pane.id, fontSize)
}

export function setTerminalFontSizeOverride(leafId: TerminalLeafId, fontSize: number): void {
  fontSizeByLeafId.set(leafId, fontSize)
}

export function clearTerminalFontSizeOverride(leafId: TerminalLeafId): void {
  fontSizeByLeafId.delete(leafId)
}

export function clearRemovedTabFontSizeOverrides(
  state: TerminalTabRetirementState,
  tab: { tabId: string; worktreeId: string },
  panes: readonly { leafId: TerminalLeafId; ptyId: string | null }[]
): void {
  for (const pane of panes) {
    // Why: a mirrored replacement tab adopts the PTY at the same durable leaf, so keep its zoom.
    const adoptedElsewhere =
      pane.ptyId !== null &&
      hasTerminalPtyOwnerOutsidePane(
        state,
        getTerminalPtyOwnershipIdentity(state, pane.ptyId, tab.worktreeId),
        tab.tabId,
        pane.leafId
      )
    if (!adoptedElsewhere) {
      fontSizeByLeafId.delete(pane.leafId)
    }
  }
}

export function resetTerminalFontSizeOverridesForTest(): void {
  fontSizeByLeafId.clear()
}
