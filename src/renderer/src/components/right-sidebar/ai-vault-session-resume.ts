import type { Repo, Worktree } from '../../../../shared/types'
import { isLocalAiVaultResumeRepo } from '@/lib/ai-vault-resume-target'
import { translate } from '@/i18n/i18n'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'

export type AiVaultSessionResumeState = {
  blocked: boolean
  worktreeId: string | null
  usesSessionWorktree: boolean
}

export type AiVaultSessionResumeAction = {
  worktreeId: string | null
  disabled: boolean
}

export type AiVaultSessionResumeActions = {
  worktree: AiVaultSessionResumeAction
  newTab: AiVaultSessionResumeAction
}

export function resolveAiVaultSessionResumeState(args: {
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
}): AiVaultSessionResumeState {
  const sessionWorktreeId =
    canJumpToAiVaultSessionWorktree(args.worktreeInfo) && args.worktreeInfo?.worktreeId
      ? args.worktreeInfo.worktreeId
      : null

  const candidateWorktreeIds = [
    sessionWorktreeId,
    args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
      ? args.activeWorktreeId
      : null
  ].filter((value): value is string => Boolean(value))

  for (const worktreeId of candidateWorktreeIds) {
    const worktree = args.worktrees.find((candidate) => candidate.id === worktreeId)
    if (!worktree) {
      continue
    }
    const repo = args.repos.find((candidate) => candidate.id === worktree.repoId)
    if (!isLocalAiVaultResumeRepo(repo)) {
      continue
    }
    return {
      blocked: false,
      worktreeId,
      usesSessionWorktree: worktreeId === sessionWorktreeId
    }
  }

  return {
    blocked: true,
    worktreeId: null,
    usesSessionWorktree: false
  }
}

export function resolveAiVaultSessionResumeActions(args: {
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
}): AiVaultSessionResumeActions {
  const sessionWorktreeId =
    canJumpToAiVaultSessionWorktree(args.worktreeInfo) && args.worktreeInfo?.worktreeId
      ? args.worktreeInfo.worktreeId
      : null

  const sessionTargetId = resolveLocalResumeWorktreeId({
    worktreeId: sessionWorktreeId,
    worktrees: args.worktrees,
    repos: args.repos
  })
  const activeTargetId = resolveLocalResumeWorktreeId({
    worktreeId:
      args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
        ? args.activeWorktreeId
        : null,
    worktrees: args.worktrees,
    repos: args.repos
  })

  return {
    worktree: {
      worktreeId: sessionWorktreeId,
      disabled: !sessionTargetId
    },
    newTab: {
      worktreeId:
        args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
          ? args.activeWorktreeId
          : null,
      disabled: !activeTargetId
    }
  }
}

function resolveLocalResumeWorktreeId(args: {
  worktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
}): string | null {
  if (!args.worktreeId) {
    return null
  }

  const worktree = args.worktrees.find((candidate) => candidate.id === args.worktreeId)
  if (!worktree) {
    return null
  }

  const repo = args.repos.find((candidate) => candidate.id === worktree.repoId)
  if (!isLocalAiVaultResumeRepo(repo)) {
    return null
  }

  return args.worktreeId
}

export function aiVaultSessionResumeLabel(
  state: Pick<AiVaultSessionResumeState, 'usesSessionWorktree'>
): string {
  if (state.usesSessionWorktree) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionDetails.resumeInWorktree',
      'Resume in Worktree'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewTab',
    'Resume in New Tab'
  )
}
