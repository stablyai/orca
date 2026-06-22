import { buildAiVaultResumeCommand, type AiVaultSession } from '../../../shared/ai-vault-types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'

type AiVaultResumeCommandSession = Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'>

export function buildAiVaultResumeCommandForWorktree(args: {
  state: Pick<
    AppState,
    'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
  >
  worktreeId?: string | null
  session: AiVaultResumeCommandSession
  commandOverride?: string | null
}): string {
  const platform = getAiVaultResumePlatform(args.state, args.worktreeId)
  const codexHome = getAiVaultResumeCodexHome(args.session.codexHome, platform)
  return buildAiVaultResumeCommand({
    agent: args.session.agent,
    sessionId: args.session.sessionId,
    cwd: args.session.cwd,
    platform,
    commandOverride: args.commandOverride,
    codexHome
  })
}

function getAiVaultResumeCodexHome(
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
  state: Pick<
    AppState,
    'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
  >,
  worktreeId?: string | null
): NodeJS.Platform {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, CLIENT_PLATFORM)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }

  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  const worktree = targetWorktreeId
    ? Object.values(state.worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === targetWorktreeId)
    : null
  return worktree?.path && parseWslUncPath(worktree.path) ? 'linux' : CLIENT_PLATFORM
}
