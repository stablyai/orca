import type { AppState } from '@/store'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { getFolderWorkspaceCandidateRepos } from '@/lib/folder-workspace-connection'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'

export type TerminalWindowTransferCaptureResult =
  | { ok: true; seed: TerminalWindowTransferSeed }
  | {
      ok: false
      error:
        | 'terminal_tab_not_found'
        | 'terminal_tab_not_active_workspace'
        | 'terminal_group_not_found'
        | 'terminal_layout_not_found'
        | 'terminal_workspace_identity_missing'
        | 'terminal_repo_not_found'
        | 'terminal_pty_not_found'
        | 'terminal_pty_mismatch'
    }

export function captureTerminalWindowTransferSeed(
  state: AppState,
  tabId: string
): TerminalWindowTransferCaptureResult {
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  if (!tab) {
    return { ok: false, error: 'terminal_tab_not_found' }
  }
  if (state.activeWorktreeId !== tab.worktreeId) {
    return { ok: false, error: 'terminal_tab_not_active_workspace' }
  }
  const unified = (state.unifiedTabsByWorktree[tab.worktreeId] ?? []).find(
    (candidate) =>
      candidate.id === tabId && candidate.entityId === tabId && candidate.contentType === 'terminal'
  )
  const group = unified
    ? (state.groupsByWorktree[tab.worktreeId] ?? []).find(
        (candidate) => candidate.id === unified.groupId
      )
    : undefined
  if (!group || group.worktreeId !== tab.worktreeId || !group.tabOrder.includes(tabId)) {
    return { ok: false, error: 'terminal_group_not_found' }
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return { ok: false, error: 'terminal_layout_not_found' }
  }
  const canonicalWorkspaceKey = isWorkspaceKey(tab.worktreeId)
    ? tab.worktreeId
    : worktreeWorkspaceKey(tab.worktreeId)
  if (state.activeWorkspaceKey && state.activeWorkspaceKey !== canonicalWorkspaceKey) {
    return { ok: false, error: 'terminal_workspace_identity_missing' }
  }
  const hostId =
    state.activeWorkspaceExecutionHostId ??
    getResolvedExecutionHostIdForWorktree(state, tab.worktreeId)
  if (!hostId) {
    return { ok: false, error: 'terminal_workspace_identity_missing' }
  }
  const scope = parseWorkspaceKey(canonicalWorkspaceKey)
  const worktree =
    scope?.type === 'folder' ? null : state.getKnownWorktreeById(tab.worktreeId, hostId)
  const repoCandidates = (
    scope?.type === 'folder'
      ? getFolderWorkspaceCandidateRepos(state, scope.folderWorkspaceId)
      : worktree
        ? state.repos.filter(({ id }) => id === worktree.repoId)
        : []
  ).filter((candidate) => getRepoExecutionHostId(candidate) === hostId)
  const activeRepo = repoCandidates.find(({ id }) => id === state.activeRepoId)
  const repo = activeRepo ?? (repoCandidates.length === 1 ? repoCandidates[0] : undefined)
  if (!repo) {
    return { ok: false, error: 'terminal_repo_not_found' }
  }
  const ptyIds = [...new Set([tab.ptyId, ...Object.values(layout.ptyIdsByLeafId ?? {})])].filter(
    (ptyId): ptyId is string => Boolean(ptyId)
  )
  if (ptyIds.length === 0) {
    return { ok: false, error: 'terminal_pty_not_found' }
  }
  const rendererPtyIds = [...new Set(state.ptyIdsByTabId[tabId] ?? [])]
  if (
    rendererPtyIds.length !== ptyIds.length ||
    rendererPtyIds.some((ptyId) => !ptyIds.includes(ptyId))
  ) {
    return { ok: false, error: 'terminal_pty_mismatch' }
  }
  const { pendingActivationSpawn: _pendingActivationSpawn, ...persistedTab } = tab
  void _pendingActivationSpawn
  return {
    ok: true,
    seed: structuredClone({
      tabId,
      hostId,
      canonicalWorkspaceKey,
      repo,
      worktreeId: tab.worktreeId,
      group,
      tab: persistedTab,
      layout,
      ptyIds
    })
  }
}
