import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useActiveRepo, useActiveWorktree, useActiveWorktreeId } from '@/store/selectors'
import {
  selectAiVaultPanelWorkspace,
  type AiVaultPanelWorkspace,
  type AiVaultPanelWorkspaceRows
} from './ai-vault-panel-workspace'

const NO_ROWS: AiVaultPanelWorkspaceRows = { worktree: null, repo: null }

/** The panel's workspace: the one it was opened for, else the active one. */
export function useAiVaultPanelWorkspace(
  workspace: AiVaultPanelWorkspace | undefined
): AiVaultPanelWorkspaceRows & { workspaceId: string | null } {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const activeRepo = useActiveRepo()
  const bound = useAppStore(
    useShallow((state) => (workspace ? selectAiVaultPanelWorkspace(state, workspace) : NO_ROWS))
  )
  return workspace
    ? { workspaceId: workspace.worktreeId, ...bound }
    : { workspaceId: activeWorktreeId, worktree: activeWorktree, repo: activeRepo }
}
