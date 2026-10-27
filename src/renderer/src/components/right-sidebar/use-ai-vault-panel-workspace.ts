import { useMemo } from 'react'
import { getProjectHostSetupCompatibilityFromState } from '@/store/project-host-setup-selector'
import { buildSetupByRepoId, resolveLegacyActiveProjectKey } from './ai-vault-project-key'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useActiveRepo, useActiveWorktree, useActiveWorktreeId } from '@/store/selectors'
import {
  selectAiVaultPanelWorkspace,
  type AiVaultPanelWorkspace,
  type AiVaultPanelWorkspaceRows
} from './ai-vault-panel-workspace'

const NO_ROWS: AiVaultPanelWorkspaceRows = { worktree: null, repo: null }

export function useAiVaultPanelWorkspace(
  workspace: AiVaultPanelWorkspace | undefined
): AiVaultPanelWorkspaceRows & { workspaceId: string | null; legacyProjectKey: string | null } {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const activeRepo = useActiveRepo()
  const bound = useAppStore(
    useShallow((state) => (workspace ? selectAiVaultPanelWorkspace(state, workspace) : NO_ROWS))
  )
  const selected = workspace
    ? { workspaceId: workspace.worktreeId, ...bound }
    : { workspaceId: activeWorktreeId, worktree: activeWorktree, repo: activeRepo }
  const compatibility = useAppStore(getProjectHostSetupCompatibilityFromState)
  const legacyProjectKey = useMemo(
    () =>
      resolveLegacyActiveProjectKey(
        selected.repo,
        selected.worktree,
        buildSetupByRepoId(compatibility.setups)
      ),
    [selected.repo, selected.worktree, compatibility]
  )
  return { ...selected, legacyProjectKey }
}
