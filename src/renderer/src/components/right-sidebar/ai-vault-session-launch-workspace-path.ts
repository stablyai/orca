import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

export function notifyAiVaultSessionPreparationFailure(error: unknown): void {
  toast.error(
    error instanceof Error
      ? error.message
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
          'Could not prepare this session for resume.'
        )
  )
}

export function resolveAiVaultTargetWorkspacePath(
  state: AiVaultSessionResumeTargetState,
  workspaceId: string
): string | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === scope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  return findWorktreeById(state.worktreesByRepo, worktreeId)?.path ?? null
}
