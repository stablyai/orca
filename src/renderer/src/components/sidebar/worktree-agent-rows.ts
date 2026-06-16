import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentType,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import {
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'
import { resolveRuntimePaneTitleLeafId } from '@/lib/runtime-pane-title-leaf-id'
import {
  buildTitleDerivedAgentRows,
  resolveAgentTypeFromTerminalTitle
} from './worktree-title-derived-agent-rows'

function tabFromAttributedStatusEntry(entry: AgentStatusEntry): TerminalTab | null {
  const parsed = parsePaneKey(entry.paneKey)
  if (!parsed || !entry.worktreeId) {
    return null
  }
  return {
    id: parsed.tabId,
    ptyId: null,
    worktreeId: entry.worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: Number.MAX_SAFE_INTEGER,
    createdAt: entry.stateStartedAt
  }
}

function resolveRowAgentType(entry: AgentStatusEntry, tab?: TerminalTab | null): AgentType {
  if (entry.agentType && entry.agentType !== 'unknown') {
    return entry.agentType
  }
  return (
    tab?.launchAgent ??
    resolveAgentTypeFromTerminalTitle(entry.terminalTitle ?? tab?.title) ??
    entry.agentType ??
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

function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}

function seenStablePaneKeysForTab(seenPaneKeys: Set<string>, tabId: string): string[] {
  const keys: string[] = []
  for (const paneKey of seenPaneKeys) {
    const parsed = parsePaneKey(paneKey)
    if (parsed?.tabId === tabId) {
      keys.push(paneKey)
    }
  }
  return keys
}

function isRetainedLegacyAliasOfSeenStablePane(args: {
  paneKey: string
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  seenPaneKeys: Set<string>
}): boolean {
  const legacy = parseLegacyNumericPaneKey(args.paneKey)
  if (!legacy) {
    return false
  }
  const stablePaneKeys = seenStablePaneKeysForTab(args.seenPaneKeys, legacy.tabId)
  if (stablePaneKeys.length === 0) {
    return false
  }

  const layout = args.terminalLayoutsByTabId?.[legacy.tabId]
  const leafId = resolveRuntimePaneTitleLeafId(layout, legacy.numericPaneId)
  if (leafId) {
    return args.seenPaneKeys.has(makePaneKey(legacy.tabId, leafId))
  }

  // Why: old PaneManager ids can advance across remounts/updates even for a
  // single physical pane. Once the tab has exactly one current stable pane,
  // retained numeric rows under that tab are stale aliases of it.
  return countTerminalLayoutLeaves(layout?.root) === 1 && stablePaneKeys.length === 1
}

export function buildWorktreeAgentRows(args: {
  tabs: TerminalTab[]
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const seenPaneKeys = new Set<string>()

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
      const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
      const isFresh = isExplicitAgentStatusFresh(rowEntry, args.now, AGENT_STATUS_STALE_AFTER_MS)
      const shouldDecay =
        !isFresh &&
        (rowEntry.state === 'working' ||
          rowEntry.state === 'blocked' ||
          rowEntry.state === 'waiting')
      rows.push({
        paneKey: rowEntry.paneKey,
        entry: rowEntry,
        tab,
        agentType: resolveRowAgentType(rowEntry, tab),
        state: shouldDecay ? 'idle' : rowEntry.state,
        startedAt: rowEntry.stateHistory[0]?.startedAt ?? rowEntry.stateStartedAt
      })
      seenPaneKeys.add(rowEntry.paneKey)
    }
  }

  rows.push(...buildTitleDerivedAgentRows({ ...args, seenPaneKeys }))

  // Why: orchestration workers can be attributed to a worktree by main before
  // their tab is present in this renderer. Keep those live rows visible in the
  // worktree card instead of waiting for tab membership that may never arrive.
  for (const entry of args.entries) {
    if (seenPaneKeys.has(entry.paneKey)) {
      continue
    }
    const rowEntry = entryWithRuntimeOrchestration(entry, args.runtimeAgentOrchestrationByPaneKey)
    const tab = tabFromAttributedStatusEntry(rowEntry)
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
      state: shouldDecay ? 'idle' : rowEntry.state,
      startedAt: rowEntry.stateHistory[0]?.startedAt ?? rowEntry.stateStartedAt
    })
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
      state: 'done',
      startedAt: ra.startedAt
    })
  }

  rows.sort((a, b) => a.startedAt - b.startedAt)
  return rows
}
