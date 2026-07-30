import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import {
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import { resolveRuntimePaneTitleLeafId } from '@/lib/runtime-pane-title-leaf-id'

export type WorktreeAgentRowLayoutGateArgs = {
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  recentlyRetiredAgentStatusPaneKeys?: Record<string, true>
}

function collectLayoutLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLayoutLeafIds(node.first), ...collectLayoutLeafIds(node.second)]
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

export function isAgentPaneKeyLiveInLayout(
  paneKey: string,
  args: WorktreeAgentRowLayoutGateArgs
): boolean {
  if (args.recentlyRetiredAgentStatusPaneKeys?.[paneKey] === true) {
    return false
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return true
  }
  const layout = args.terminalLayoutsByTabId?.[parsed.tabId]
  if (!layout?.root) {
    return true
  }
  return collectLayoutLeafIds(layout.root).includes(parsed.leafId)
}

export function isRetainedLegacyAliasOfSeenStablePane(args: {
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

  return countTerminalLayoutLeaves(layout?.root) === 1 && stablePaneKeys.length === 1
}

function markSeenPaneKeyForCurrentTab(args: {
  paneKey: string | undefined
  currentTabIds: Set<string>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  seenPaneKeys: Set<string>
}): void {
  if (!args.paneKey) {
    return
  }
  const parsed = parsePaneKey(args.paneKey)
  if (parsed) {
    if (args.currentTabIds.has(parsed.tabId)) {
      args.seenPaneKeys.add(args.paneKey)
    }
    return
  }

  const legacy = parseLegacyNumericPaneKey(args.paneKey)
  if (!legacy || !args.currentTabIds.has(legacy.tabId)) {
    return
  }
  args.seenPaneKeys.add(args.paneKey)
  const leafId = resolveRuntimePaneTitleLeafId(
    args.terminalLayoutsByTabId?.[legacy.tabId],
    legacy.numericPaneId
  )
  if (leafId) {
    args.seenPaneKeys.add(makePaneKey(legacy.tabId, leafId))
  }
}

export function markCompletedWorkerParentPaneKeysSeen(args: {
  entries: AgentStatusEntry[]
  retained: RetainedAgentEntry[]
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  currentTabIds: Set<string>
  seenPaneKeys: Set<string>
  entryWithRuntimeOrchestration: (entry: AgentStatusEntry) => AgentStatusEntry
}): void {
  const markEntry = (entry: AgentStatusEntry): void => {
    const rowEntry = args.entryWithRuntimeOrchestration(entry)
    if (rowEntry.state !== 'done') {
      return
    }
    markSeenPaneKeyForCurrentTab({
      paneKey: rowEntry.orchestration?.parentPaneKey,
      currentTabIds: args.currentTabIds,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      seenPaneKeys: args.seenPaneKeys
    })
  }

  for (const entry of args.entries) {
    markEntry(entry)
  }
  for (const retained of args.retained) {
    markEntry(retained.entry)
  }
}
