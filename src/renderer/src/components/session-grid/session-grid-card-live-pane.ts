import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

export type SessionGridCardLivePane = {
  /** The tab's live pty, or null while it is parked or still spawning. Never a guess. */
  ptyId: string | null
  /** Pane key of that pty's leaf; what the input resolver keys agent evidence on. */
  paneKey: string | null
}

type TerminalLayoutLeaves = {
  activeLeafId: string | null
  ptyIdsByLeafId?: Record<string, string>
}

/**
 * The pty a card may preview. Layout entries survive restarts but their PTYs
 * may not, so only a pty listed in `ptyIdsByTabId` — the liveness truth — is
 * advertised; the layout's active leaf wins over `tab.ptyId`, which for a
 * split tab names the wrong pane.
 */
export function resolveSessionGridCardLivePane(
  tab: TerminalTab,
  layout: TerminalLayoutLeaves | undefined,
  livePtyIds: readonly string[]
): SessionGridCardLivePane {
  const leafId = layout?.activeLeafId ?? null
  const leafPtyId = leafId ? (layout?.ptyIdsByLeafId?.[leafId] ?? null) : null
  if (leafId && leafPtyId && livePtyIds.includes(leafPtyId)) {
    return {
      ptyId: leafPtyId,
      paneKey: isTerminalLeafId(leafId) ? makePaneKey(tab.id, leafId) : null
    }
  }
  if (!tab.ptyId || !livePtyIds.includes(tab.ptyId)) {
    return { ptyId: null, paneKey: null }
  }
  // Why: without a pane key the input resolver gives up and the preview encodes keys for the CLIENT OS, not the pty host's.
  const boundLeafId = Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
    ([, ptyId]) => ptyId === tab.ptyId
  )?.[0]
  return {
    ptyId: tab.ptyId,
    paneKey: boundLeafId && isTerminalLeafId(boundLeafId) ? makePaneKey(tab.id, boundLeafId) : null
  }
}
