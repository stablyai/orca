import type { AppState } from '@/store'

type EditorPanelGitEntryState = Pick<AppState, 'gitBranchChangesByWorktree' | 'gitStatusByWorktree'>

export function selectEditorPanelGitStatusEntries(
  state: Pick<EditorPanelGitEntryState, 'gitStatusByWorktree'>,
  worktreeId: string | null | undefined
): AppState['gitStatusByWorktree'][string] | undefined {
  return worktreeId ? state.gitStatusByWorktree[worktreeId] : undefined
}

export function selectEditorPanelGitBranchEntries(
  state: Pick<EditorPanelGitEntryState, 'gitBranchChangesByWorktree'>,
  worktreeId: string | null | undefined
): AppState['gitBranchChangesByWorktree'][string] | undefined {
  return worktreeId ? state.gitBranchChangesByWorktree[worktreeId] : undefined
}
