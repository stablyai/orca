import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

export type AgentFilterTabEvidence = {
  id?: string
  launchAgent?: TerminalTab['launchAgent']
  title?: string | null
  paneTitles?: readonly (string | null | undefined)[]
}

export type AgentFilterLayoutsByTabId =
  | Record<string, TerminalLayoutSnapshot | undefined>
  | null
  | undefined

/**
 * Why: card title rows grant launch-agent ownership only while the layout has
 * one leaf. Live/parked title counts cannot tell a leftover parked slot from a
 * sibling pane, so a split with one live title must not inherit the tab owner.
 */
function grantsLaunchAgentOwnership(
  tab: AgentFilterTabEvidence,
  layout: TerminalLayoutSnapshot | undefined
): boolean {
  if (layout) {
    return layout.root?.type === 'leaf'
  }
  return tab.paneTitles != null && tab.paneTitles.length <= 1
}

export function paneTitlesAndLaunchOwnerForAgentFilter(
  tab: AgentFilterTabEvidence,
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>> | null,
  terminalLayoutsByTabId?: AgentFilterLayoutsByTabId
): {
  titles: readonly (string | null | undefined)[]
  owner: TerminalTab['launchAgent'] | null
} {
  const layout = tab.id ? terminalLayoutsByTabId?.[tab.id] : undefined
  const owner = grantsLaunchAgentOwnership(tab, layout) ? (tab.launchAgent ?? null) : null
  if (tab.paneTitles) {
    return { titles: tab.paneTitles, owner }
  }
  const byPane = tab.id ? runtimePaneTitlesByTabId?.[tab.id] : undefined
  if (!byPane) {
    return { titles: [], owner }
  }
  const live: string[] = []
  const parked: string[] = []
  for (const [paneId, title] of Object.entries(byPane)) {
    if (Number(paneId) >= FIRST_PANE_ID) {
      live.push(title)
    } else {
      parked.push(title)
    }
  }
  return { titles: [...live, ...parked], owner }
}
