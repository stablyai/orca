import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

const AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS = 10_000

type TerminalNotificationEvent = {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  paneKey?: string
}

function hasLivePtyForWorktree(
  state: ReturnType<typeof useAppStore.getState>,
  candidateWorktreeId: string
): boolean {
  const tabs = state.tabsByWorktree[candidateWorktreeId] ?? []
  return tabs.some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0)
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

function hasActiveWorktreeState(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
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

function countReposWithWorktrees(state: ReturnType<typeof useAppStore.getState>): number {
  let count = 0
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    if (worktrees.length > 0) {
      count += 1
    }
  }
  return count
}

function countReposNeedingNotificationDisambiguation(
  state: ReturnType<typeof useAppStore.getState>
): number {
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

  // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously
  // before killing PTYs asynchronously. Any notification arriving after
  // that point is stale — e.g. a staleTitleTimer that fires 3 s after
  // shutdown, or an agent tracker transition from accumulated closure
  // state. Checking for live PTYs at dispatch time catches ALL phantom
  // notification sources regardless of which timer or callback produced
  // them, rather than trying to cancel each one individually.
  if (!hasLivePtyForWorktree(state, worktreeId)) {
    return
  }

  // Why: prefer worktree.repoId over string-parsing the worktreeId. The
  // `${repoId}::${path}` format is an implementation detail of id
  // construction; coupling the notification dispatcher to it would silently
  // drop the repo label if that format ever changes. The worktree object
  // itself is the source of truth for its owning repo.
  const worktree = getWorktreeMapFromState(state).get(worktreeId)
  const repo = worktree ? getRepoMapFromState(state).get(worktree.repoId) : null
  const customSoundPath = state.settings?.notifications?.customSoundPath ?? null
  const agentStatus =
    event.source === 'agent-task-complete' && event.paneKey
      ? state.agentStatusByPaneKey[event.paneKey]
      : undefined
  // Why: pane keys are reused across turns. A rich OS notification must not
  // expose the previous turn's prompt if the current turn has no fresh hook snapshot yet.
  const hasFreshAgentStatus =
    agentStatus && Date.now() - agentStatus.updatedAt <= AGENT_NOTIFICATION_SNAPSHOT_MAX_AGE_MS
  const agentSnapshot = hasFreshAgentStatus
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
      repoLabel: repo?.displayName,
      worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
      hasMultipleActiveRepos: countReposNeedingNotificationDisambiguation(state) > 1,
      terminalTitle: event.terminalTitle,
      isActiveWorktree: state.activeWorktreeId === worktreeId,
      ...agentSnapshot
    })
    .then((result) => {
      if (result.delivered) {
        void playDesktopNotificationSound(customSoundPath)
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
