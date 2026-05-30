import type { Repo, Worktree } from '../../../shared/types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { hasSleepableWorkspaceActivity } from '@/lib/worktree-sleepable-activity'
import { hasFreshLiveAgent, hasWorkingTitleAgent } from '@/lib/worktree-live-agent-blockers'

export type AutoSleepInactiveWorkspacesState = {
  activeWorktreeId: string | null
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  tabsByWorktree: Record<string, { id: string; title: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  lastVisitedAtByWorktreeId: Record<string, number>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimePaneTitlesByTabId: Record<string, Record<string, string>>
  openFiles: { id: string; worktreeId: string; isDirty?: boolean }[]
  editorDrafts: Record<string, unknown>
  sshConnectionStates: Map<string, SshConnectionState>
}

function isRepoSshDisconnected(
  repo: Repo,
  sshConnectionStates: Map<string, SshConnectionState>
): boolean {
  if (!repo.connectionId) {
    return false
  }
  return sshConnectionStates.get(repo.connectionId)?.status !== 'connected'
}

function hasDirtyEditorBuffer(
  worktreeId: string,
  openFiles: AutoSleepInactiveWorkspacesState['openFiles'],
  editorDrafts: AutoSleepInactiveWorkspacesState['editorDrafts']
): boolean {
  return openFiles.some(
    (file) =>
      file.worktreeId === worktreeId && (file.isDirty || editorDrafts[file.id] !== undefined)
  )
}

function hasMobileLockedPty(
  worktreeId: string,
  tabsByWorktree: AutoSleepInactiveWorkspacesState['tabsByWorktree'],
  ptyIdsByTabId: AutoSleepInactiveWorkspacesState['ptyIdsByTabId']
): boolean {
  const tabs = tabsByWorktree[worktreeId] ?? []
  for (const tab of tabs) {
    for (const ptyId of ptyIdsByTabId[tab.id] ?? []) {
      if (isPtyLocked(ptyId)) {
        return true
      }
    }
  }
  return false
}

function shouldAutoSleepWorktree(
  worktree: Worktree,
  repo: Repo,
  state: AutoSleepInactiveWorkspacesState,
  now: number
): boolean {
  const inactiveAfterMs = repo.autoSleepInactiveWorkspacesAfterMs
  if (inactiveAfterMs == null || inactiveAfterMs <= 0) {
    return false
  }
  if (state.activeWorktreeId === worktree.id) {
    return false
  }
  if (worktree.isPinned) {
    return false
  }
  if (isRepoSshDisconnected(repo, state.sshConnectionStates)) {
    return false
  }
  if (
    !hasSleepableWorkspaceActivity(
      worktree.id,
      state.tabsByWorktree,
      state.ptyIdsByTabId,
      state.browserTabsByWorktree
    )
  ) {
    return false
  }

  const lastVisitedAt = state.lastVisitedAtByWorktreeId[worktree.id] ?? 0
  if (lastVisitedAt <= 0) {
    return false
  }
  if (now - lastVisitedAt < inactiveAfterMs) {
    return false
  }

  const tabs = state.tabsByWorktree[worktree.id] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  if (hasDirtyEditorBuffer(worktree.id, state.openFiles, state.editorDrafts)) {
    return false
  }
  if (hasFreshLiveAgent(state.agentStatusByPaneKey, tabIds, now)) {
    return false
  }
  if (hasWorkingTitleAgent(tabs, state.ptyIdsByTabId, state.runtimePaneTitlesByTabId)) {
    return false
  }
  if (hasMobileLockedPty(worktree.id, state.tabsByWorktree, state.ptyIdsByTabId)) {
    return false
  }

  return true
}

export function collectAutoSleepWorktreeIds(
  state: AutoSleepInactiveWorkspacesState,
  now: number = Date.now()
): string[] {
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const ids: string[] = []

  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      const repo = repoById.get(worktree.repoId)
      if (!repo) {
        continue
      }
      if (shouldAutoSleepWorktree(worktree, repo, state, now)) {
        ids.push(worktree.id)
      }
    }
  }

  return ids
}
