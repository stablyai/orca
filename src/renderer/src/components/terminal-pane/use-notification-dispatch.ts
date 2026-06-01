import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

const AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS = 10_000

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

export type TerminalNotificationEvent = {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  paneKey?: string
  agentStatusSnapshot?: ParsedAgentStatusPayload
}

function hasLivePtyForWorktree(state: StoreSnapshot, candidateWorktreeId: string): boolean {
  const tabs = state.tabsByWorktree[candidateWorktreeId] ?? []
  return tabs.some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0)
}

function hasLivePtyForPaneKey(state: StoreSnapshot, paneKey: string | undefined): boolean {
  if (!paneKey) {
    return false
  }
  const tabId = getPaneKeyTabId(paneKey)
  return tabId !== null && (state.ptyIdsByTabId[tabId] ?? []).length > 0
}

function hasLivePtyForNotification(
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

function isCurrentLivePaneKey(state: StoreSnapshot, worktreeId: string, paneKey: string): boolean {
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

  const livePtyIds = state.ptyIdsByTabId[parsed.tabId] ?? []
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

function isSuppressedPtyHint(state: StoreSnapshot, ptyId: string | null | undefined): boolean {
  return Boolean(ptyId && state.suppressedPtyExitIds?.[ptyId])
}

function isCurrentKnownPaneKey(state: StoreSnapshot, worktreeId: string, paneKey: string): boolean {
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

function getPaneKeyTabId(paneKey: string): string | null {
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

function countReposNeedingNotificationDisambiguation(state: StoreSnapshot): number {
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

function isOrcaWindowForegroundFocused(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function dispatchTerminalNotification(
  worktreeId: string,
  event: TerminalNotificationEvent
): void {
  const state = useAppStore.getState()
  const storedAgentStatus =
    event.source === 'agent-task-complete' && event.paneKey
      ? state.agentStatusByPaneKey[event.paneKey]
      : undefined
  const freshStoredAgentStatus =
    storedAgentStatus &&
    Date.now() - storedAgentStatus.updatedAt <= AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS
      ? storedAgentStatus
      : undefined
  const agentStatus =
    event.source === 'agent-task-complete'
      ? (event.agentStatusSnapshot ?? freshStoredAgentStatus)
      : undefined
  // Why: main-process hook IPC can update inactive/unmounted worktrees before
  // the renderer's live-PTY map catches up. A fresh accepted hook snapshot is
  // authoritative for agent completion; title/BEL-only paths still need PTY liveness.
  const hasFreshAgentStatus = Boolean(agentStatus)

  // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously
  // before killing PTYs asynchronously. Any notification arriving after
  // that point is stale — e.g. a staleTitleTimer that fires 3 s after
  // shutdown, or an agent tracker transition from accumulated closure
  // state. Checking for live PTYs at dispatch time catches ALL phantom
  // notification sources regardless of which timer or callback produced
  // them, rather than trying to cancel each one individually.
  const hasLivePty = hasLivePtyForNotification(state, worktreeId, event.paneKey)
  if (!hasLivePty && !hasFreshAgentStatus) {
    return
  }

  if (event.source === 'agent-task-complete') {
    const terminalAttentionEnabled = state.settings?.experimentalTerminalAttention === true
    let tabId: string | null = null
    if (event.paneKey) {
      tabId = getPaneKeyTabId(event.paneKey)
      // Why: delayed completion hooks from a closed split pane can arrive while
      // another pane in the tab is still live; stale leaf completions must not
      // create unread state or OS notifications.
      const isCurrentPane = hasLivePty
        ? isCurrentLivePaneKey(state, worktreeId, event.paneKey)
        : isCurrentKnownPaneKey(state, worktreeId, event.paneKey)
      if (!tabId || !isCurrentPane) {
        return
      }
    }

    if (terminalAttentionEnabled && tabId && event.paneKey) {
      state.markWorktreeUnread(worktreeId)
      state.markTerminalTabUnread(tabId)
      state.markTerminalPaneUnread(event.paneKey)
    } else if (state.activeWorktreeId !== worktreeId || !isOrcaWindowForegroundFocused()) {
      // Why: activeWorktreeId is only in-app selection. If Orca is backgrounded,
      // a selected chat finishing still needs unread/Dock attention.
      state.markWorktreeUnread(worktreeId)
    }
  }

  // Why: prefer worktree.repoId over string-parsing the worktreeId. The
  // `${repoId}::${path}` format is an implementation detail of id
  // construction; coupling the notification dispatcher to it would silently
  // drop the repo label if that format ever changes. The worktree object
  // itself is the source of truth for its owning repo.
  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  const repo = worktree ? getRepoMapFromState(state).get(worktree.repoId) : null
  const customSoundId = state.settings?.notifications?.customSoundId ?? 'system'
  const customSoundVolume = state.settings?.notifications?.customSoundVolume ?? null
  // Why: pane keys are reused across turns. A rich OS notification must not
  // expose the previous turn's prompt if the current turn has no fresh hook snapshot yet.
  const agentSnapshot = agentStatus
    ? {
        agentType: agentStatus.agentType,
        agentState: agentStatus.state,
        agentPrompt: agentStatus.prompt,
        agentToolName: agentStatus.toolName,
        agentToolInput: agentStatus.toolInput,
        agentLastAssistantMessage: agentStatus.lastAssistantMessage,
        agentInterrupted: agentStatus.interrupted
      }
    : {}

  void window.api.notifications
    .dispatch({
      source: event.source,
      worktreeId,
      paneKey: event.paneKey,
      repoLabel: repo?.displayName,
      worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
      hasMultipleActiveRepos: countReposNeedingNotificationDisambiguation(state) > 1,
      terminalTitle: event.terminalTitle,
      isActiveWorktree: state.activeWorktreeId === worktreeId,
      ...agentSnapshot
    })
    .then((result) => {
      if (result.delivered) {
        void playDesktopNotificationSound(customSoundId, customSoundVolume)
      }
    })
    .catch((err) => {
      console.warn('Failed to dispatch notification:', err)
    })
}

export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => dispatchTerminalNotification(worktreeId, event),
    [worktreeId]
  )
}
