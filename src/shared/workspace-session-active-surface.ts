import type { SessionUnitReader } from './session-unit-reader'

import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { readSessionUnit } from './session-unit-reader'

export function pickNextActiveTabAfterClose(
  group: Pick<TabGroup, 'tabOrder' | 'recentTabIds'>,
  closingIds: ReadonlySet<string>,
  remaining: readonly string[],
  remainingIds: ReadonlySet<string>
): string | null {
  for (let index = (group.recentTabIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const id = group.recentTabIds![index]
    if (remainingIds.has(id)) {
      return id
    }
  }
  const firstIndices = new Map<string, number>()
  group.tabOrder.forEach((id, index) => {
    if (!firstIndices.has(id)) {
      firstIndices.set(id, index)
    }
  })
  const closingIndex = group.tabOrder.findIndex((id) => closingIds.has(id))
  // -1 matches the pre-index `indexOf` miss, so an id outside `group.tabOrder` never wins.
  return (
    remaining.find((id) => (firstIndices.get(id) ?? -1) > closingIndex) ?? remaining.at(-1) ?? null
  )
}

export function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return validGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, validGroupIds)
  const second = pruneGroupLayout(node.second, validGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

export function deriveActiveSurface(
  session: WorkspaceSessionState | SessionUnitReader,
  worktreeId: string,
  tabs: Tab[],
  groups: TabGroup[],
  activeGroupId: string | undefined
): {
  terminalTabId: string | null
  browserTabId: string | null
  fileId: string | null
  type: WorkspaceVisibleTabType
} {
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null
  const activeUnified = activeGroup?.activeTabId
    ? (tabs.find((tab) => tab.id === activeGroup.activeTabId && tab.groupId === activeGroup.id) ??
      null)
    : null
  const terminalTabs = readSessionUnit(session, 'tabsByWorktree', worktreeId) ?? []
  const browsers = readSessionUnit(session, 'browserTabsByWorktree', worktreeId) ?? []
  const files = readSessionUnit(session, 'openFilesByWorktree', worktreeId) ?? []
  const priorTerminal = readSessionUnit(session, 'activeTabIdByWorktree', worktreeId)
  const terminalFallback = terminalTabs.some((tab) => tab.id === priorTerminal)
    ? (priorTerminal ?? null)
    : (terminalTabs[0]?.id ?? null)
  const priorBrowser = readSessionUnit(session, 'activeBrowserTabIdByWorktree', worktreeId)
  const browserFallback = browsers.some((tab) => tab.id === priorBrowser)
    ? (priorBrowser ?? null)
    : (browsers[0]?.id ?? null)
  const priorFile = readSessionUnit(session, 'activeFileIdByWorktree', worktreeId)
  const fileFallback = files.some((file) => file.filePath === priorFile)
    ? (priorFile ?? null)
    : (files[0]?.filePath ?? null)

  if (activeUnified?.contentType === 'terminal') {
    return {
      terminalTabId: activeUnified.entityId,
      browserTabId: browserFallback,
      fileId: fileFallback,
      type: 'terminal'
    }
  }
  if (activeUnified?.contentType === 'browser') {
    return {
      terminalTabId: terminalFallback,
      browserTabId: activeUnified.entityId,
      fileId: fileFallback,
      type: 'browser'
    }
  }
  if (activeUnified) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: activeUnified.entityId,
      type: activeUnified.contentType === 'simulator' ? 'simulator' : 'editor'
    }
  }
  if (fileFallback) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: fileFallback,
      type: 'editor'
    }
  }
  if (browserFallback) {
    return {
      terminalTabId: terminalFallback,
      browserTabId: browserFallback,
      fileId: null,
      type: 'browser'
    }
  }
  return { terminalTabId: terminalFallback, browserTabId: null, fileId: null, type: 'terminal' }
}
