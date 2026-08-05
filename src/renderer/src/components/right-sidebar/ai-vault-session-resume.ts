import type { Repo, Worktree } from '../../../../shared/types'
import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspacePath,
  getAiVaultResumeWorkspaceTargetStatus,
  getAiVaultResumeWorkspaceWslDistro
} from '@/lib/ai-vault-resume-target'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'
import { hasCursorResumeTarget } from './ai-vault-session-continuation'

export type AiVaultSessionResumeTargetState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'projects' | 'settings'>>

export type AiVaultSessionResumeState = {
  blocked: boolean
  worktreeId: string | null
  usesSessionWorktree: boolean
  cursorCommandAvailable?: boolean
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
  sessionAgent?: AiVaultSession['agent']
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState?: AiVaultSessionResumeTargetState
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
  const targetState = resolveAiVaultResumeTargetState(args)

  for (const worktreeId of candidateWorktreeIds) {
    const targetId = resolveSupportedResumeWorktreeId({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId: args.sessionExecutionHostId,
      sessionAgent: args.sessionAgent,
      worktreeId,
      targetState
    })
    if (!targetId) {
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
  sessionAgent?: AiVaultSession['agent']
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState?: AiVaultSessionResumeTargetState
}): AiVaultSessionResumeActions {
  const sessionWorktreeId =
    canJumpToAiVaultSessionWorktree(args.worktreeInfo) && args.worktreeInfo?.worktreeId
      ? args.worktreeInfo.worktreeId
      : null
  const targetState = resolveAiVaultResumeTargetState(args)

  const sessionTargetId = resolveSupportedResumeWorktreeId({
    sessionFilePath: args.sessionFilePath,
    sessionExecutionHostId: args.sessionExecutionHostId,
    sessionAgent: args.sessionAgent,
    worktreeId: sessionWorktreeId,
    targetState
  })
  const activeTargetId = resolveSupportedResumeWorktreeId({
    sessionFilePath: args.sessionFilePath,
    sessionExecutionHostId: args.sessionExecutionHostId,
    sessionAgent: args.sessionAgent,
    worktreeId:
      args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
        ? args.activeWorktreeId
        : null,
    targetState
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

export function isKnownAiVaultResumeWorkspaceTarget(
  state: AiVaultSessionResumeTargetState,
  workspaceId: string | null
): boolean {
  if (!workspaceId) {
    return false
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return state.folderWorkspaces.some(
      (workspace) => workspace.id === workspaceKey.folderWorkspaceId
    )
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  return getIndexedWorktreeMap(state.worktreesByRepo).has(worktreeId)
}

function resolveSupportedResumeWorktreeId(args: {
  sessionAgent?: AiVaultSession['agent']
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  worktreeId: string | null
  targetState: AiVaultSessionResumeTargetState
}): string | null {
  if (!args.worktreeId) {
    return null
  }

  if (!isKnownAiVaultResumeWorkspaceTarget(args.targetState, args.worktreeId)) {
    return null
  }

  const targetStatus = getAiVaultResumeWorkspaceTargetStatus(args.targetState, args.worktreeId)
  const targetExecutionHostId = getAiVaultResumeWorkspaceExecutionHostId(
    args.targetState,
    args.worktreeId
  )
  if (
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId: args.sessionExecutionHostId,
      sessionAgent: args.sessionAgent,
      targetStatus,
      targetExecutionHostId,
      targetWorkspacePath: getAiVaultResumeWorkspacePath(args.targetState, args.worktreeId),
      targetWslDistro: getAiVaultResumeWorkspaceWslDistro(args.targetState, args.worktreeId)
    })
  ) {
    return null
  }

  return args.worktreeId
}

function resolveAiVaultResumeTargetState(args: {
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState?: AiVaultSessionResumeTargetState
}): AiVaultSessionResumeTargetState {
  if (args.targetState) {
    return args.targetState
  }
  const worktreesByRepo: AiVaultSessionResumeTargetState['worktreesByRepo'] = {}
  for (const worktree of args.worktrees) {
    worktreesByRepo[worktree.repoId] = [...(worktreesByRepo[worktree.repoId] ?? []), worktree]
  }
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [...args.repos],
    worktreesByRepo
  }
}

// Resume needs actual conversation content: a zero-turn transcript would resume
// into an empty session. Workspace-target blocking only disables in-app resume;
// copying the command stays available for blocked-but-real sessions, so the copy
// affordance is gated on content alone.
export function aiVaultSessionRowResumeGating(
  session: Pick<AiVaultSession, 'messageCount' | 'previewMessages' | 'hasConversation'> &
    Partial<Pick<AiVaultSession, 'agent' | 'cwd' | 'resumeCommand'>>,
  state:
    | (Pick<AiVaultSessionResumeState, 'blocked'> &
        Partial<Pick<AiVaultSessionResumeState, 'cursorCommandAvailable'>>)
    | null
): { resumeDisabled: boolean; canCopyResumeCommand: boolean } {
  const hasResumableContent = isAiVaultSessionResumableContent(session)
  const cursorResumable = hasCursorResumeTarget(session, state?.cursorCommandAvailable === true)
  return {
    resumeDisabled: (state?.blocked ?? true) || !hasResumableContent || !cursorResumable,
    canCopyResumeCommand: hasResumableContent && cursorResumable
  }
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
