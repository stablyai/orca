import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { resolveRuntimePaneTitleLeafId } from '../sidebar/runtime-pane-title-leaf-id'

export type TabAgentActivity = 'working' | null

type TabAgentActivityInput = {
  tab: Pick<TerminalTab, 'id' | 'title'>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  now?: number
}

type FreshTabStatusEntry = {
  entry: AgentStatusEntry
  leafId: string | null
  legacyNumericPaneId: string | null
}

export function getTabAgentActivity({
  tab,
  agentStatusByPaneKey,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  terminalLayoutsByTabId,
  now = Date.now()
}: TabAgentActivityInput): TabAgentActivity {
  const freshEntries = getFreshAgentStatusEntriesForTab(agentStatusByPaneKey, tab.id, now)
  if (freshEntries.length > 0) {
    if (freshEntries.some(({ entry }) => entry.state === 'working')) {
      return 'working'
    }
    return getTitleDerivedActivity({
      tab,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      freshEntries
    })
  }

  // Why: title-derived activity can linger after sleep/replay; require a live
  // PTY before showing the pulsing tab badge from terminal-title heuristics.
  return getTitleDerivedActivity({ tab, runtimePaneTitlesByTabId, ptyIdsByTabId })
}

function getTitleDerivedActivity({
  tab,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  terminalLayoutsByTabId,
  freshEntries = []
}: Pick<TabAgentActivityInput, 'tab' | 'runtimePaneTitlesByTabId' | 'ptyIdsByTabId'> & {
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  freshEntries?: FreshTabStatusEntry[]
}): TabAgentActivity {
  if ((ptyIdsByTabId[tab.id]?.length ?? 0) === 0) {
    return null
  }
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    const tabLayout = terminalLayoutsByTabId?.[tab.id]
    const paneTitleEntries = Object.entries(paneTitles)
    for (const [runtimePaneId, title] of paneTitleEntries) {
      if (
        freshEntries.length > 0 &&
        titlePaneHasFreshExplicitStatus({
          freshEntries,
          paneTitleEntries,
          runtimePaneId,
          tabLayout
        })
      ) {
        continue
      }
      if (detectAgentStatusFromTitle(title) === 'working') {
        return 'working'
      }
    }
    return null
  }

  // Why: a tab-level title does not identify its split pane. Once a fresh hook
  // owns any pane in the tab, prefer hook authority over a stale working title.
  if (freshEntries.length > 0) {
    return null
  }

  return detectAgentStatusFromTitle(tab.title) === 'working' ? 'working' : null
}

function titlePaneHasFreshExplicitStatus({
  freshEntries,
  paneTitleEntries,
  runtimePaneId,
  tabLayout
}: {
  freshEntries: FreshTabStatusEntry[]
  paneTitleEntries: [string, string][]
  runtimePaneId: string
  tabLayout: TerminalLayoutSnapshot | undefined
}): boolean {
  if (freshEntries.some((entry) => entry.legacyNumericPaneId === runtimePaneId)) {
    return true
  }

  const leafId = resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId)
  if (leafId && freshEntries.some((entry) => entry.leafId === leafId)) {
    return true
  }

  // Why: SSH/replay can deliver a runtime title before layout hydration. With
  // one title and one hook row, the pane is unambiguous enough to trust hooks.
  return leafId === null && freshEntries.length === 1 && paneTitleEntries.length === 1
}

function getFreshAgentStatusEntriesForTab(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string,
  now: number
): FreshTabStatusEntry[] {
  const entries: FreshTabStatusEntry[] = []
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const entryPaneKey = entry.paneKey || paneKey
    const parsedPaneKey = parsePaneKey(entryPaneKey)
    const legacyPaneKey = parsedPaneKey ? null : parseLegacyNumericPaneKey(entryPaneKey)
    const entryTabId = parsedPaneKey?.tabId ?? legacyPaneKey?.tabId
    if (entryTabId !== tabId) {
      continue
    }
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    entries.push({
      entry,
      leafId: parsedPaneKey?.leafId ?? null,
      legacyNumericPaneId: legacyPaneKey?.numericPaneId ?? null
    })
  }
  return entries
}
