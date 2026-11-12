import { getAiVaultResumeWorkspaceWslDistro } from '@/lib/agent-session/resume/history/ai-vault-resume-shell'
import { canResumeAiVaultSessionOnTarget } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-target'
import {
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from '@/lib/agent-session/resume/history/ai-vault-resume-target'
import { translate } from '@/i18n/i18n'
import { findAiVaultHistoryWorktree } from '@/lib/agent-session/resume/history/ai-vault-history-worktrees'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  isKnownAiVaultResumeWorkspaceTarget,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'

export function resolveAiVaultTargetWorkspacePath(
  state: AiVaultSessionResumeTargetState,
  workspaceId: string,
  executionHostId?: AiVaultSession['executionHostId'] | null
): string | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return (
      selectFolderWorkspaces(state).find((workspace) => workspace.id === scope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  return findAiVaultHistoryWorktree(state, worktreeId, executionHostId)?.path ?? null
}

export type AiVaultSessionLaunchTarget =
  | { status: 'missing' }
  | {
      status: 'unsupported'
      targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
    }
  | {
      status: 'ready'
      worktreeId: string
      executionHostId: AiVaultSession['executionHostId'] | null
    }

export function resolveAiVaultSessionLaunchTarget(args: {
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  activeWorktreeId: string | null
  targetWorktreeId?: string
  sessionWorktreeId?: string | null
  targetState: AiVaultSessionResumeTargetState
}): AiVaultSessionLaunchTarget {
  const targetWorktreeId = args.targetWorktreeId ?? args.activeWorktreeId
  if (
    !targetWorktreeId ||
    !isKnownAiVaultResumeWorkspaceTarget(
      args.targetState,
      targetWorktreeId,
      args.sessionExecutionHostId,
      args.sessionWorktreeId
    )
  ) {
    return { status: 'missing' }
  }

  const targetStatus = getAiVaultResumeWorkspaceTargetStatus(
    args.targetState,
    targetWorktreeId,
    args.sessionExecutionHostId
  )
  const targetExecutionHostId = getAiVaultResumeWorkspaceExecutionHostId(
    args.targetState,
    targetWorktreeId,
    args.sessionExecutionHostId
  )
  if (
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId: args.sessionExecutionHostId,
      targetStatus,
      targetExecutionHostId,
      targetWslDistro: getAiVaultResumeWorkspaceWslDistro(
        args.targetState,
        targetWorktreeId,
        args.sessionExecutionHostId
      )
    })
  ) {
    return { status: 'unsupported', targetStatus }
  }

  return { status: 'ready', worktreeId: targetWorktreeId, executionHostId: targetExecutionHostId }
}

export function aiVaultResumeUnsupportedMessage(
  targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
): string {
  // Otherwise-valid host types here mean the session host differs from the selected workspace.
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
