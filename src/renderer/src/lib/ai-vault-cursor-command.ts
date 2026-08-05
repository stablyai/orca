import { resolveEffectiveCursorCommand } from '../../../shared/cursor-command'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { getLocalAgentPreflightContext, localPreflightContextKey } from './local-preflight-context'
import type { AppState } from '@/store/types'
import type { AiVaultSession } from '../../../shared/ai-vault-types'

export type CursorCommandState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
> &
  Partial<
    Pick<
      AppState,
      | 'activeRepoId'
      | 'activeWorktreeId'
      | 'detectedAgentCommands'
      | 'detectedAgentCommandsByContext'
      | 'projects'
      | 'remoteDetectedAgentCommands'
      | 'runtimeDetectedAgentCommands'
      | 'settings'
    >
  >

export function resolveAiVaultCursorCommand(args: {
  state: CursorCommandState
  worktreeId?: string | null
  repoId?: string | null
  executionHostId?: ExecutionHostId | null
  workspacePath?: string | null
  commandOverride?: string | null
}): string | null {
  const repo = args.repoId
    ? args.state.repos.find((candidate) => candidate.id === args.repoId)
    : null
  const host = parseExecutionHostId(
    args.executionHostId ??
      (repo
        ? getRepoExecutionHostId(repo)
        : getExecutionHostIdForWorktree(args.state, args.worktreeId ?? args.state.activeWorktreeId))
  )
  let matches: Partial<Record<TuiAgent, string>> | undefined
  if (host?.kind === 'ssh') {
    matches = args.state.remoteDetectedAgentCommands?.[host.targetId]
  } else if (host?.kind === 'runtime') {
    matches = args.state.runtimeDetectedAgentCommands?.[host.environmentId]
  } else {
    const workspaceDistro = parseWslUncPath(args.workspacePath ?? '')?.distro
    const contextKey = workspaceDistro
      ? `wsl:${workspaceDistro}`
      : localPreflightContextKey(
          getLocalAgentPreflightContext(
            (args.repoId
              ? { ...args.state, activeRepoId: args.repoId, activeWorktreeId: null }
              : args.state) as AppState,
            undefined,
            undefined,
            args.worktreeId
          )
        )
    // Older preflight/preload payloads carry only the flat map; keep a missing
    // context result authoritative once the context-indexed map exists.
    matches = args.state.detectedAgentCommandsByContext
      ? args.state.detectedAgentCommandsByContext[contextKey]
      : args.state.detectedAgentCommands
  }
  return resolveEffectiveCursorCommand(args.commandOverride, {
    version: 1,
    agents: matches?.cursor ? ['cursor'] : [],
    matchedCommands: matches ?? {}
  })
}

export function resolveCursorCommandOverrides(args: {
  state: CursorCommandState
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  worktreeId?: string | null
  repoId?: string | null
  executionHostId?: ExecutionHostId | null
  workspacePath?: string | null
}): Partial<Record<TuiAgent, string>> {
  if (args.agent !== 'cursor') {
    return args.cmdOverrides
  }
  const command = resolveAiVaultCursorCommand({
    state: args.state,
    worktreeId: args.worktreeId,
    repoId: args.repoId,
    executionHostId: args.executionHostId,
    workspacePath: args.workspacePath,
    commandOverride: args.cmdOverrides.cursor
  })
  return command ? { ...args.cmdOverrides, cursor: command } : args.cmdOverrides
}

export function resolveWorktreeAgentCommandOverrides(
  state: CursorCommandState,
  agent: TuiAgent,
  worktreeId: string
): Partial<Record<TuiAgent, string>> {
  return resolveCursorCommandOverrides({
    state,
    agent,
    worktreeId,
    cmdOverrides: { ...state.settings?.agentCmdOverrides }
  })
}

export function resolveAiVaultResumeCommandOverride(args: {
  state: CursorCommandState
  worktreeId?: string | null
  session: Pick<AiVaultSession, 'agent' | 'cwd'>
  commandOverride?: string | null
}): string | null | undefined {
  if (args.session.agent !== 'cursor') {
    return args.commandOverride
  }
  const command = resolveAiVaultCursorCommand(args)
  if (!args.session.cwd || !command?.trim()) {
    throw new Error(
      args.session.cwd
        ? 'Cursor CLI not detected on this host.'
        : 'Cursor did not record a resumable workspace for this session.'
    )
  }
  return command
}
