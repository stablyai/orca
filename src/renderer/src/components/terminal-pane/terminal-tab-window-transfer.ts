import type { AppState } from '@/store'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
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
  if (!group) {
    return { ok: false, error: 'terminal_group_not_found' }
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return { ok: false, error: 'terminal_layout_not_found' }
  }
  const canonicalWorkspaceKey =
    state.activeWorkspaceKey ??
    (isWorkspaceKey(tab.worktreeId) ? tab.worktreeId : worktreeWorkspaceKey(tab.worktreeId))
  const hostId =
    state.activeWorkspaceExecutionHostId ??
    getResolvedExecutionHostIdForWorktree(state, tab.worktreeId)
  if (!hostId) {
    return { ok: false, error: 'terminal_workspace_identity_missing' }
  }
  const activeRepo = state.activeRepoId
    ? state.repos.find(
        (candidate) =>
          candidate.id === state.activeRepoId && getRepoExecutionHostId(candidate) === hostId
      )
    : undefined
  const worktree = activeRepo ? null : state.getKnownWorktreeById(tab.worktreeId, hostId)
  const repoCandidates = worktree ? state.repos.filter(({ id }) => id === worktree.repoId) : []
  const repo =
    activeRepo ??
    repoCandidates.find((candidate) => getRepoExecutionHostId(candidate) === hostId) ??
    (repoCandidates.length === 1 ? repoCandidates[0] : undefined)
  if (!repo) {
    return { ok: false, error: 'terminal_repo_not_found' }
  }
  const ptyIds = [
    ...new Set([
      ...Object.values(layout.ptyIdsByLeafId ?? {}),
      ...(state.ptyIdsByTabId[tabId] ?? []),
      ...(tab.ptyId ? [tab.ptyId] : [])
    ])
  ].filter(Boolean)
  if (ptyIds.length === 0) {
    return { ok: false, error: 'terminal_pty_not_found' }
  }
  return {
    ok: true,
    seed: structuredClone({
      tabId,
      hostId,
      canonicalWorkspaceKey,
      repo,
      worktreeId: tab.worktreeId,
      group,
      tab,
      layout,
      ptyIds
    })
  }
}
