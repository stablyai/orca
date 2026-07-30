import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentType,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  buildTitleDerivedAgentRows,
  resolveAgentTypeFromTerminalTitle
} from './worktree-title-derived-agent-rows'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { compareWorktreeAgentRows } from './worktree-agent-row-order'
import {
  effectiveWorktreeAgentRowStartedAt,
  tabFromWorktreeAttributedStatusEntry
} from './worktree-agent-row-fallback-tab'
import {
  isAgentPaneKeyLiveInLayout,
  isRetainedLegacyAliasOfSeenStablePane,
  markCompletedWorkerParentPaneKeysSeen
} from './worktree-agent-row-pane-gates'

/**
 * Resolves the sidebar row agent type, prioritizing launch agent configuration
 * and normalizing compatible agent kinds.
 */
function resolveRowAgentType(entry: AgentStatusEntry, tab?: TerminalTab | null): AgentType {
  const entryAgentType = resolveCompatibleAgentTypeForOwner(entry.agentType, tab?.launchAgent)
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return (
    resolveAgentTypeFromTerminalTitle(entry.terminalTitle ?? tab?.title, tab?.launchAgent) ??
    tab?.launchAgent ??
    entryAgentType ??
    'unknown'
  )
}

function orchestrationContextsEqual(
  a: AgentStatusOrchestrationContext,
  b: AgentStatusOrchestrationContext
): boolean {
  return (
    a.taskId === b.taskId &&
    a.dispatchId === b.dispatchId &&
    a.taskTitle === b.taskTitle &&
    a.displayName === b.displayName &&
    a.parentTerminalHandle === b.parentTerminalHandle &&
    a.parentPaneKey === b.parentPaneKey &&
    a.coordinatorHandle === b.coordinatorHandle &&
    a.orchestrationRunId === b.orchestrationRunId
  )
}

function entryWithRuntimeOrchestration(
  entry: AgentStatusEntry,
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext> | undefined
): AgentStatusEntry {
  const runtimeOrchestration = runtimeAgentOrchestrationByPaneKey?.[entry.paneKey]
  const sameDispatch =
    entry.orchestration &&
    runtimeOrchestration &&
    entry.orchestration.taskId === runtimeOrchestration.taskId &&
    entry.orchestration.dispatchId === runtimeOrchestration.dispatchId
  if (entry.orchestration && runtimeOrchestration && !sameDispatch) {
    return entry
  }
  const orchestration =
    sameDispatch && entry.orchestration && runtimeOrchestration
      ? { ...entry.orchestration, ...runtimeOrchestration }
      : (runtimeOrchestration ?? entry.orchestration)
  if (!orchestration || orchestration === entry.orchestration) {
    return entry
  }
  if (entry.orchestration && orchestrationContextsEqual(entry.orchestration, orchestration)) {
    return entry
  }
  // Why: runtime graph metadata can arrive after a hook status ping. Keep old
  // fields only for the same dispatch; a reused terminal must not inherit a
  // previous worker's stale parent.
  return { ...entry, orchestration }
}

export function buildWorktreeAgentRows(args: {
  tabs: TerminalTab[]
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  recentlyRetiredAgentStatusPaneKeys?: Record<string, true>
  suppressedTitleDerivedLeafIdsByTabId?: Record<string, Record<string, true>>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const seenPaneKeys = new Set<string>()
  const currentTabIds = new Set(args.tabs.map((tab) => tab.id))

  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const entry of args.entries) {
    const parsed = parsePaneKey(entry.paneKey)
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

  for (const tab of args.tabs) {
    const explicitEntries = entriesByTabId.get(tab.id) ?? []
    for (const entry of explicitEntries) {
      if (!isAgentPaneKeyLiveInLayout(entry.paneKey, args)) {
        continue
      }
      const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
      const isFresh = isExplicitAgentStatusFresh(rowEntry, args.now, AGENT_STATUS_STALE_AFTER_MS)
      const shouldDecay =
        !isFresh &&
        (rowEntry.state === 'working' ||
          rowEntry.state === 'blocked' ||
          rowEntry.state === 'waiting')
      const startedAt = effectiveWorktreeAgentRowStartedAt(rowEntry)
      rows.push({
        paneKey: rowEntry.paneKey,
        entry: rowEntry,
        tab,
        agentType: resolveRowAgentType(rowEntry, tab),
        rowSource: 'live',
        state: shouldDecay ? 'idle' : rowEntry.state,
        startedAt
      })
      rows.push(...buildSubagentChildRows({ parentEntry: rowEntry, tab, parentIsFresh: isFresh }))
      seenPaneKeys.add(rowEntry.paneKey)
    }
  }

  markCompletedWorkerParentPaneKeysSeen({
    entries: args.entries,
    retained: args.retained,
    runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId: args.terminalLayoutsByTabId,
    currentTabIds,
    seenPaneKeys,
    entryWithRuntimeOrchestration: (entry) =>
      entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
  })

  rows.push(...buildTitleDerivedAgentRows({ ...args, seenPaneKeys }))

  // Why: orchestration workers can be attributed to a worktree by main before
  // their tab is present in this renderer. Keep those live rows visible in the
  // worktree card instead of waiting for tab membership that may never arrive.
  for (const entry of args.entries) {
    if (seenPaneKeys.has(entry.paneKey)) {
      continue
    }
    if (!isAgentPaneKeyLiveInLayout(entry.paneKey, args)) {
      continue
    }
    const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
    const startedAt = effectiveWorktreeAgentRowStartedAt(rowEntry)
    const tab = tabFromWorktreeAttributedStatusEntry(rowEntry, startedAt)
    if (!tab) {
      continue
    }
    const isFresh = isExplicitAgentStatusFresh(rowEntry, args.now, AGENT_STATUS_STALE_AFTER_MS)
    const shouldDecay =
      !isFresh &&
      (rowEntry.state === 'working' || rowEntry.state === 'blocked' || rowEntry.state === 'waiting')
    rows.push({
      paneKey: rowEntry.paneKey,
      entry: rowEntry,
      tab,
      agentType: resolveRowAgentType(rowEntry, tab),
      rowSource: 'live',
      state: shouldDecay ? 'idle' : rowEntry.state,
      startedAt
    })
    rows.push(...buildSubagentChildRows({ parentEntry: rowEntry, tab, parentIsFresh: isFresh }))
    seenPaneKeys.add(rowEntry.paneKey)
  }

  for (const ra of args.retained) {
    if (seenPaneKeys.has(ra.entry.paneKey)) {
      continue
    }
    if (
      isRetainedLegacyAliasOfSeenStablePane({
        paneKey: ra.entry.paneKey,
        terminalLayoutsByTabId: args.terminalLayoutsByTabId,
        seenPaneKeys
      })
    ) {
      continue
    }
    const rowEntry = entryWithRuntimeOrchestration(
      ra.entry,
      args.runtimeAgentOrchestrationByPaneKey
    )
    rows.push({
      paneKey: rowEntry.paneKey,
      entry: rowEntry,
      tab: ra.tab,
      agentType: resolveRowAgentType(rowEntry, ra.tab),
      rowSource: 'retained',
      state: 'done',
      startedAt: ra.startedAt
    })
  }

  // Why: hook pings can rebuild the live entry list in a different iteration
  // order. Equal-start agents still need a deterministic sidebar order.
  rows.sort(compareWorktreeAgentRows)
  return rows
}
