import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from '@/lib/ai-vault-resume-target'
import { translate } from '@/i18n/i18n'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  isKnownAiVaultResumeWorkspaceTarget,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'

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

export type AiVaultSessionLaunchTarget =
  | { status: 'missing' }
  | {
      status: 'unsupported'
      targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
    }
  | { status: 'ready'; worktreeId: string }

export function resolveAiVaultSessionLaunchTarget(args: {
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  activeWorktreeId: string | null
  targetWorktreeId?: string
  targetState: AiVaultSessionResumeTargetState
}): AiVaultSessionLaunchTarget {
  const targetWorktreeId = args.targetWorktreeId ?? args.activeWorktreeId
  if (
    !targetWorktreeId ||
    !isKnownAiVaultResumeWorkspaceTarget(args.targetState, targetWorktreeId)
  ) {
    return { status: 'missing' }
  }

  const targetStatus = getAiVaultResumeWorkspaceTargetStatus(args.targetState, targetWorktreeId)
  const targetExecutionHostId = getAiVaultResumeWorkspaceExecutionHostId(
    args.targetState,
    targetWorktreeId
  )
  if (
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId: args.sessionExecutionHostId,
      targetStatus,
      targetExecutionHostId
    })
  ) {
    return { status: 'unsupported', targetStatus }
  }

  return { status: 'ready', worktreeId: targetWorktreeId }
}

export function aiVaultResumeUnsupportedMessage(
  targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
): string {
  // Why: local and SSH targets can both be valid generally; this branch means
  // the session's recorded host does not match the selected workspace.
  if (targetStatus === 'ssh' || targetStatus === 'local' || targetStatus === 'runtime') {
    return translate(
      'auto.components.right.sidebar.AiVaultPanel.sessionHostMismatchUnsupported',
      'This session belongs to a different host. Open a workspace on the same host to resume it.'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultPanel.openSupportedWorkspace',
    'Open a workspace before resuming a session.'
  )
}
