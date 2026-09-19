import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getAiVaultResumeWorkspacePath } from './ai-vault-resume-cwd'
import { resolveAiVaultResumeStartupShell } from './ai-vault-resume-shell'

export type AiVaultResumeRuntimeState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

export function resolveAiVaultResumeShell(args: {
  state: AiVaultResumeRuntimeState
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  worktreeId?: string | null
}): ReturnType<typeof resolveAiVaultResumeStartupShell> {
  const platform = getAiVaultResumePlatform(args.state, args.worktreeId)
  const isLocalSession =
    !args.sessionExecutionHostId || args.sessionExecutionHostId === LOCAL_EXECUTION_HOST_ID
  return resolveAiVaultResumeStartupShell({
    state: args.state,
    worktreeId: args.worktreeId,
    platform,
    isLocalSession
  })
}

export function getAiVaultAgentProviderSession(
  session: Pick<AiVaultSession, 'agent' | 'sessionId'> & { filePath?: string }
): AgentProviderSessionMetadata | null {
  if (!isResumableTuiAgent(session.agent)) {
    return null
  }
  if (session.agent === 'antigravity') {
    return { key: 'conversation_id', id: session.sessionId }
  }
  if (session.agent === 'pi' || session.agent === 'prime-agent') {
    return session.filePath
      ? { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath }
      : null
  }
  return { key: 'session_id', id: session.sessionId }
}

export function getAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  // Why: WSL UNC Codex homes must be POSIX when invoking Linux commands.
  // Keep original paths unchanged for non-Linux targets.
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}

export function getAiVaultResumePlatform(
  state: AiVaultResumeRuntimeState,
  worktreeId?: string | null
): NodeJS.Platform {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(state, targetWorktreeId))
  if (executionHost?.kind === 'ssh' || executionHost?.kind === 'runtime') {
    return 'linux'
  }

  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, CLIENT_PLATFORM)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }

  const workspacePath = getAiVaultResumeWorkspacePath(state, targetWorktreeId)
  return workspacePath && parseWslUncPath(workspacePath) ? 'linux' : CLIENT_PLATFORM
}
