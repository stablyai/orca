import { isAntigravityReferenceSession } from '../../../../../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { canResumeAiVaultSessionOnTarget } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-target'
import {
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from './ai-vault-resume-target'
import { getAiVaultResumeWorkspaceWslDistro } from './ai-vault-resume-shell'
import type { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'

export function assertAntigravityReferenceTarget(
  args: Parameters<typeof buildAiVaultResumeStartupForWorktree>[0]
): void {
  const workspaceId = args.worktreeId ?? args.state.activeWorktreeId
  if (
    isAntigravityReferenceSession(args.session) &&
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.session.filePath,
      sessionExecutionHostId: args.session.executionHostId,
      targetStatus: getAiVaultResumeWorkspaceTargetStatus(args.state, workspaceId),
      targetExecutionHostId: getAiVaultResumeWorkspaceExecutionHostId(args.state, workspaceId),
      targetWslDistro: getAiVaultResumeWorkspaceWslDistro(args.state, workspaceId)
    })
  ) {
    throw new Error(
      'The Antigravity transcript belongs to a different execution host or WSL distro.'
    )
  }
}
