import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { parseAgentStatusPaneIdentity } from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../../../shared/agent-status/contracts/agent-status-freshness'

import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveAgentRowState } from '../../../../../../shared/agent-status/presentation/agent-row-decay-state'
import { tabHasLivePty } from '../../../../../../shared/workspace-layout/terminal-surfaces/tab-has-live-pty'
import { buildTitleDerivedAgentRows } from './worktree-title-derived-agent-rows'
import { legacyStatusTitleRowKey } from './legacy-status-title-row-key'
import type { TitleDerivedPaneForeground } from './title-derived-pane-agent-identity'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'
import { compareWorktreeAgentRows } from './worktree-agent-row-order'
import { tabFromWorktreeAttributedStatusEntry } from './worktree-agent-row-fallback-tab'
import { agentEntrySessionStartedAt as effectiveWorktreeAgentRowStartedAt } from '../../../../../../shared/agent-session/lifecycle/resume/agent-session-start-time'
import { resolveRowAgentType } from './worktree-agent-row-type'
import { entryWithRuntimeOrchestration } from './worktree-agent-row-orchestration'

function collectCompletedWorkerParentPaneKeys(args: {
  entries: AgentStatusEntry[]
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  currentTabsById: ReadonlyMap<string, TerminalTab>
}): Set<string> {
  const parentPaneKeys = new Set<string>()
  for (const entry of args.entries) {
    const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
    if (rowEntry.state !== 'done') {
      continue
    }
    // Completed workers may own a visible parent pane’s stale spinner title.
    const parentPaneKey = rowEntry.orchestration?.parentPaneKey
    const parent = parseAgentStatusPaneIdentity(parentPaneKey)
    if (parentPaneKey && parent && args.currentTabsById.has(parent.tabId)) {
      parentPaneKeys.add(parentPaneKey)
    }
  }
  return parentPaneKeys
}

export function buildExplicitWorktreeAgentRows(
  entry: AgentStatusEntry,
  tab: TerminalTab,
  now: number,
  hasLivePty: boolean,
  orchestration?: Record<string, AgentStatusOrchestrationContext>
): DashboardAgentRow[] {
  const rowEntry = entryWithRuntimeOrchestration(entry, orchestration)
  return [
    {
      paneKey: rowEntry.paneKey,
      entry: rowEntry,
      tab,
      agentType: resolveRowAgentType(rowEntry, tab),
      rowSource: 'live',
      state: resolveAgentRowState(rowEntry, now, hasLivePty),
      startedAt: effectiveWorktreeAgentRowStartedAt(rowEntry)
    },
    ...buildSubagentChildRows({
      parentEntry: rowEntry,
      tab,
      parentIsFresh: isAgentStatusFresh(rowEntry, now, AGENT_STATUS_STALE_AFTER_MS)
    })
  ]
}

export function buildWorktreeAgentRows(args: {
  tabs: TerminalTab[]
  representedTabs?: ReadonlyMap<string, Tab>
  entries: AgentStatusEntry[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const seenPaneKeys = new Set<string>()
  const currentTabsById = new Map(args.tabs.map((tab) => [tab.id, tab] as const))

  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of args.entries) {
    const parsed = parseAgentStatusPaneIdentity(
      entry.paneKey,
      args.representedTabs?.get(entry.paneKey)
    )
    if (!parsed) {
      continue
    }
    const bucket = entriesByTabId.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByTabId.set(parsed.tabId, [entry])
    }
  }

  const ptyIdsByTabId = args.ptyIdsByTabId ?? {}

  for (const tab of args.tabs) {
    const explicitEntries = entriesByTabId.get(tab.id) ?? []
    const hasLivePty = tabHasLivePty(ptyIdsByTabId, tab.id)
    for (const entry of explicitEntries) {
      const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
      const isFresh = isAgentStatusFresh(rowEntry, args.now, AGENT_STATUS_STALE_AFTER_MS)
      const startedAt = effectiveWorktreeAgentRowStartedAt(rowEntry)
      rows.push({
        paneKey: rowEntry.paneKey,
        entry: rowEntry,
        tab,
        agentType: resolveRowAgentType(rowEntry, tab),
        rowSource: 'live',
        state: resolveAgentRowState(rowEntry, args.now, hasLivePty),
        startedAt
      })
      rows.push(...buildSubagentChildRows({ parentEntry: rowEntry, tab, parentIsFresh: isFresh }))
      seenPaneKeys.add(rowEntry.paneKey)
    }
  }

  const doneParentPaneKeys = collectCompletedWorkerParentPaneKeys({
    entries: args.entries,
    runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey,
    currentTabsById
  })
  for (const paneKey of doneParentPaneKeys) {
    seenPaneKeys.add(paneKey)
  }

  const titleRows = buildTitleDerivedAgentRows({ ...args, seenPaneKeys })
  // Why: only done-worker parents hide a title row here; explicit legacy entries keep theirs as cleanup evidence.
  const hiddenTitleRowKeys = new Set(
    Array.from(doneParentPaneKeys, (paneKey) =>
      legacyStatusTitleRowKey(paneKey, args.terminalLayoutsByTabId, (tabId) =>
        titleRows.filter((row) => row.tab.id === tabId)
      )
    )
  )
  rows.push(...titleRows.filter((row) => !hiddenTitleRowKeys.has(row.paneKey)))

  // Main can attribute workers before tabs hydrate; keep them visible without waiting for local membership.
  for (const entry of args.entries) {
    if (seenPaneKeys.has(entry.paneKey)) {
      continue
    }
    const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
    const startedAt = effectiveWorktreeAgentRowStartedAt(rowEntry)
    const tab = tabFromWorktreeAttributedStatusEntry(
      rowEntry,
      startedAt,
      args.representedTabs?.get(rowEntry.paneKey)
    )
    if (!tab) {
      continue
    }
    const isFresh = isAgentStatusFresh(rowEntry, args.now, AGENT_STATUS_STALE_AFTER_MS)
    rows.push({
      paneKey: rowEntry.paneKey,
      entry: rowEntry,
      tab,
      agentType: resolveRowAgentType(rowEntry, tab),
      rowSource: 'live',
      // Even synthesized tabs use available PTY evidence to distinguish idle from unverifiable decay.
      state: resolveAgentRowState(rowEntry, args.now, tabHasLivePty(ptyIdsByTabId, tab.id)),
      startedAt
    })
    rows.push(...buildSubagentChildRows({ parentEntry: rowEntry, tab, parentIsFresh: isFresh }))
    seenPaneKeys.add(rowEntry.paneKey)
  }

  // Status pings can reorder entries; sort equal-start agents deterministically.
  rows.sort(compareWorktreeAgentRows)
  return rows
}
