import {
  getMobileAiVaultResumeWorktreeTargetStatus,
  isSupportedMobileAiVaultResumeTargetStatus,
  mobileAiVaultResumeTargetBlockMessage,
  type MobileAiVaultResumeFolderWorkspace,
  type MobileAiVaultResumeProjectGroup,
  type MobileAiVaultResumeRepo
} from './mobile-ai-vault-resume-host-status'
import type { AiVaultSession } from './ai-vault-types'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree,
  type MobileAiVaultWorktree
} from './mobile-ai-vault-session-worktree'

export type MobileAiVaultSessionResumeTarget =
  | {
      status: 'ready'
      worktreeId: string
      targetStatus: 'local'
      workspacePath: string | null
      terminalPlatform: NodeJS.Platform | null
    }
  | { status: 'blocked'; message: string }

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly (MobileAiVaultWorktree & { terminalPlatform?: NodeJS.Platform })[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultSessionResumeTarget {
  const sessionWorktree = resolveMobileAgentHistorySessionWorktree({
    session: args.session,
    worktrees: args.worktrees,
    activeWorktreeId: args.activeWorktreeId
  })
  const sessionWorktreeId = canResumeInMobileSessionWorktree(sessionWorktree)
    ? sessionWorktree?.worktreeId
    : null
  const candidateWorktreeIds = [
    sessionWorktreeId,
    args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
      ? args.activeWorktreeId
      : null
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidateWorktreeId of candidateWorktreeIds) {
    const targetStatus = getMobileAiVaultResumeWorktreeTargetStatus({
      worktreeId: candidateWorktreeId,
      worktrees: args.worktrees,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces,
      projectGroups: args.projectGroups
    })
    if (!isSupportedMobileAiVaultResumeTargetStatus(targetStatus)) {
      continue
    }
    return {
      status: 'ready',
      worktreeId: candidateWorktreeId,
      targetStatus,
      workspacePath:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)?.path ??
        null,
      terminalPlatform:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)
          ?.terminalPlatform ?? null
    }
  }

  const blockedStatus = getMobileAiVaultResumeWorktreeTargetStatus({
    worktreeId: candidateWorktreeIds[0] ?? args.activeWorktreeId,
    worktrees: args.worktrees,
    repos: args.repos,
    folderWorkspaces: args.folderWorkspaces,
    projectGroups: args.projectGroups
  })
  return { status: 'blocked', message: mobileAiVaultResumeTargetBlockMessage(blockedStatus) }
}
