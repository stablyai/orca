import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

export function getPaneKeyTabId(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId
  }

  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0 || sepIdx !== paneKey.lastIndexOf(':') || sepIdx === paneKey.length - 1) {
    return null
  }
  return paneKey.slice(0, sepIdx)
}

function isSuppressedPtyHint(state: StoreSnapshot, ptyId: string | null | undefined): boolean {
  return Boolean(ptyId && state.suppressedPtyExitIds?.[ptyId])
}

function hasLivePtyForWorktree(state: StoreSnapshot, candidateWorktreeId: string): boolean {
  const tabs = state.tabsByWorktree[candidateWorktreeId] ?? []
  return tabs.some((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

function hasLivePtyForPaneKey(state: StoreSnapshot, paneKey: string | undefined): boolean {
  if (!paneKey) {
    return false
  }
  const tabId = getPaneKeyTabId(paneKey)
  return (
    tabId !== null &&
    (state.ptyIdsByTabId[tabId] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

export function hasLivePtyForNotification(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string | undefined
): boolean {
  // Why: inactive-worktree hook completions can arrive while the worktree tab
  // list is between renderer hydration states; the pane-key PTY binding is the
  // live terminal source in that path.
  return hasLivePtyForWorktree(state, worktreeId) || hasLivePtyForPaneKey(state, paneKey)
}

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

export function isCurrentLivePaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  const tabExistsInAnotherWorktree = Object.entries(state.tabsByWorktree).some(
    ([candidateWorktreeId, tabs]) =>
      candidateWorktreeId !== worktreeId && tabs.some((tab) => tab.id === parsed.tabId)
  )
  if (tabExistsInAnotherWorktree) {
    return false
  }

  const livePtyIds = (state.ptyIdsByTabId[parsed.tabId] ?? []).filter(
    (ptyId) => !isSuppressedPtyHint(state, ptyId)
  )
  if (livePtyIds.length === 0) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (!layout) {
    return true
  }

  if (!layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout.ptyIdsByLeafId?.[parsed.leafId]
  // Why: layout hydration can briefly know the leaf before restoring its PTY
  // binding; the tab-level live PTY list remains the liveness source then.
  return leafPtyId === undefined || livePtyIds.includes(leafPtyId)
}

export function isCurrentKnownPaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  let targetTabPtyId: string | null | undefined
  for (const [candidateWorktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === parsed.tabId)
    if (!tab) {
      continue
    }
    if (candidateWorktreeId !== worktreeId) {
      return false
    }
    targetTabPtyId = tab.ptyId
  }
  if (targetTabPtyId === undefined) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && !layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Why: when there is no live PTY map yet, a tab/leaf PTY hint proves this is
  // an inactive-but-current pane. If hydration has no hint yet, keep accepting
  // known-tab hook snapshots; only explicit suppressed hints mean teardown.
  const ptyHints = [targetTabPtyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !isSuppressedPtyHint(state, ptyId))
}

function hasActiveWorktreeState(state: StoreSnapshot, worktreeId: string): boolean {
  if (hasLivePtyForWorktree(state, worktreeId)) {
    return true
  }

  if ((state.browserTabsByWorktree?.[worktreeId] ?? []).length > 0) {
    return true
  }

  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  if (worktree?.workspaceStatus === 'in-progress') {
    return true
  }

  if (
    Object.values(state.retainedAgentsByPaneKey ?? {}).some(
      (agent) => agent.worktreeId === worktreeId
    )
  ) {
    return true
  }

  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  if (tabIds.size === 0) {
    return false
  }

  const now = Date.now()
  return Object.values(state.agentStatusByPaneKey ?? {}).some((entry) => {
    const tabId = getPaneKeyTabId(entry.paneKey)
    return (
      tabId !== null &&
      tabIds.has(tabId) &&
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    )
  })
}

function countReposWithWorktrees(state: StoreSnapshot): number {
  let count = 0
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    if (worktrees.length > 0) {
      count += 1
    }
  }
  return count
}

export function countReposNeedingNotificationDisambiguation(state: StoreSnapshot): number {
  const activeRepoIds = new Set<string>()
  const worktreeMap = getWorktreeMapFromState(state)
  for (const worktreeId of Object.keys(state.tabsByWorktree)) {
    if (!hasActiveWorktreeState(state, worktreeId)) {
      continue
    }
    const repoId = worktreeMap.get(worktreeId)?.repoId
    if (repoId) {
      activeRepoIds.add(repoId)
    }
  }
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    if (activeRepoIds.has(repoId)) {
      continue
    }
    if (worktrees.some((worktree) => hasActiveWorktreeState(state, worktree.id))) {
      activeRepoIds.add(repoId)
    }
  }
  return Math.max(activeRepoIds.size, countReposWithWorktrees(state))
}
