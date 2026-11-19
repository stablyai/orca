import { useShallow } from 'zustand/react/shallow'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import {
  useActiveWorktree,
  useActiveWorktreeId
} from '@/store/workspaces/selection/use-selected-worktree'
import {
  selectAiVaultPanelWorkspace,
  type AiVaultPanelWorkspace,
  type AiVaultPanelWorkspaceRows
} from './ai-vault-panel-workspace'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

const NO_ROWS: AiVaultPanelWorkspaceRows = { worktree: null, repo: null }

export function useAiVaultPanelWorkspace(
  workspace: AiVaultPanelWorkspace | undefined
): AiVaultPanelWorkspaceRows & { workspaceId: string | null } {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const activeRepo = useActiveRepo()
  const bound = useAppStoreWithChannels(
    useShallow((state) => (workspace ? selectAiVaultPanelWorkspace(state, workspace) : NO_ROWS))
  )
  return workspace
    ? { workspaceId: workspace.worktreeId, ...bound }
    : { workspaceId: activeWorktreeId, worktree: activeWorktree, repo: activeRepo }
}
