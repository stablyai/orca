import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from '../../../shared/ai-vault-resume-command'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import { normalizeAiVaultResumeFilePath } from '../../../shared/ai-vault-resume-path'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { AppState } from '@/store/types'
import type { AiVaultSessionDragPayload } from '@/lib/ai-vault-session-drag'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import {
  getAiVaultResumeWorkspacePath,
  resolveAiVaultResumeStartupShell
} from '@/lib/ai-vault-resume-shell'

type AiVaultResumeCommandSession = Pick<
  AiVaultSession,
  'agent' | 'sessionId' | 'cwd' | 'codexHome'
> &
  Partial<
    Pick<AiVaultSession, 'executionHostId' | 'executionHostPlatform' | 'resumeCommand' | 'filePath'>
  >

export type AiVaultResumeStartup = {
  command: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  providerSession?: AgentProviderSessionMetadata
}

type AiVaultResumeWorktreeArgs = {
  state: Pick<
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
  worktreeId?: string | null
  session: AiVaultResumeCommandSession
  commandOverride?: string | null
}

export function buildAiVaultResumeCopyCommandForWorktree(args: AiVaultResumeWorktreeArgs): string {
  // Why an `env -u` prefix on the agent rather than a preceding clear statement:
  // this text is COPIED, so it runs in a shell Orca never spawned and cannot
  // seed. A clear statement has to test `$fish_pid`, an unbound expansion that
  // aborts the line under `set -u` — and because the clear came first, it took
  // the agent launch down with it (the regression that reverted #14863).
  const clearEnvNames =
    args.session.agent === 'codex' && args.session.codexHome === null
      ? (['CODEX_HOME', 'ORCA_CODEX_HOME'] as const)
      : undefined
  return buildAiVaultResumeForWorktree(args, true, clearEnvNames).command
}

export function buildAiVaultResumeStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeForWorktree(args, false)
}

/**
 * Rebuilds a drag-drop resume startup under the account home the host
 * substituted, or null when the payload cannot be repinned.
 *
 * Why: the drag payload's prebuilt command pins the session's recorded home,
 * which the substitution just proved belongs to the wrong account. A null
 * sessionCwd is a real value (session has no cwd; rebuild without a cd
 * prefix); only an ABSENT sessionCwd — a payload from an older serializer —
 * declines, because the original cwd is unrecoverable.
 */
export function buildAiVaultDropRepinStartup(args: {
  state: AiVaultResumeWorktreeArgs['state']
  payload: Pick<
    AiVaultSessionDragPayload,
    'agent' | 'sessionId' | 'sessionCwd' | 'sessionExecutionHostId' | 'sessionFilePath'
  >
  substituteCodexHome: string
  worktreeId: string
}): AiVaultResumeStartup | null {
  if (args.payload.sessionCwd === undefined || !args.payload.sessionFilePath) {
    return null
  }
  return buildAiVaultResumeStartupForWorktree({
    state: args.state,
    worktreeId: args.worktreeId,
    session: {
      agent: args.payload.agent,
      sessionId: args.payload.sessionId,
      cwd: args.payload.sessionCwd,
      codexHome: args.substituteCodexHome,
      executionHostId: args.payload.sessionExecutionHostId,
      filePath: args.payload.sessionFilePath
    },
    commandOverride: args.state.settings?.agentCmdOverrides?.[args.payload.agent]
  })
}

function buildAiVaultResumeForWorktree(
  args: AiVaultResumeWorktreeArgs,
  embedCwd: boolean,
  /** Copy-path only: names the pasted line must strip off the agent itself.
   *  Spawned startups drop them through `envToDelete` instead. */
  clearEnvNames?: readonly string[]
): AiVaultResumeStartup {
  const providerSession = getAiVaultAgentProviderSession(args.session)
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    args.session.agent !== 'omp' &&
    !(args.session.agent === 'codex' && args.session.codexHome === null) &&
    !args.commandOverride?.trim()
  ) {
    return {
      command: args.session.resumeCommand,
      ...realHomeCodexResumeEnvDeletion(args.session),
      ...(providerSession ? { providerSession } : {})
    }
  }
  const platform =
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.executionHostPlatform
      ? args.session.executionHostPlatform
      : getAiVaultResumePlatform(args.state, args.worktreeId)
  const codexHome = getAiVaultResumeCodexHome(args.session.codexHome, platform)
  const isLocalSession =
    !args.session.executionHostId || args.session.executionHostId === LOCAL_EXECUTION_HOST_ID
  const resumeFilePath = normalizeAiVaultResumeFilePath(args.session.filePath, platform)
  // Why: local shell settings do not describe a remote Windows host, whose
  // queued resume command uses the remote default PowerShell syntax.
  const liveShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? isLocalSession
        ? resolveAiVaultResumeShell(args)
        : 'powershell'
      : undefined
  const cwd = embedCwd ? args.session.cwd : null
  const startupCwd = !embedCwd && args.session.cwd ? { cwd: args.session.cwd } : {}
  if (providerSession && isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession,
      cmdOverrides: {
        ...args.state.settings?.agentCmdOverrides,
        ...(args.commandOverride?.trim() ? { [args.session.agent]: args.commandOverride } : {})
      },
      platform,
      shell: liveShell,
      agentArgs: resolveTuiAgentLaunchArgs(
        args.session.agent,
        args.state.settings?.agentDefaultArgs
      ),
      agentEnv: resolveTuiAgentLaunchEnv(args.session.agent, args.state.settings?.agentDefaultEnv),
      ...(args.session.agent === 'omp' && resumeFilePath
        ? { ompResumeFilePath: resumeFilePath }
        : {})
    })
    if (startupPlan) {
      return {
        command:
          args.session.agent === 'omp'
            ? buildAiVaultResumeCommand({
                agent: args.session.agent,
                sessionId: args.session.sessionId,
                resumeFilePath,
                cwd,
                platform,
                commandOverride: startupPlan.launchConfig.agentCommand,
                codexHome,
                shell: liveShell,
                clearEnvNames
              })
            : buildAiVaultResumeShellCommand({
                resumeCommand: startupPlan.launchCommand,
                cwd,
                platform,
                codexHome,
                shell: liveShell,
                clearEnvNames
              }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        ...realHomeCodexResumeEnvDeletion(args.session),
        ...startupCwd,
        launchConfig: startupPlan.launchConfig,
        providerSession
      }
    }
  }

  return {
    command: buildAiVaultResumeCommand({
      agent: args.session.agent,
      sessionId: args.session.sessionId,
      // Why: OMP resumes by absolute transcript path, so local rebuilds must
      // forward it too — otherwise a custom OMP_CODING_AGENT_DIR / WSL-store
      // session would resume by id against the default store and miss.
      resumeFilePath,
      cwd,
      platform,
      commandOverride: args.commandOverride,
      codexHome,
      // Why: non-resumable agents queue through this fallback too, so it must
      // quote for the live Windows shell like the startup-plan branch above.
      shell: liveShell,
      clearEnvNames
    }),
    ...startupCwd,
    ...realHomeCodexResumeEnvDeletion(args.session)
  }
}

function resolveAiVaultResumeShell(args: AiVaultResumeWorktreeArgs): AgentStartupShell {
  const platform =
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.executionHostPlatform
      ? args.session.executionHostPlatform
      : getAiVaultResumePlatform(args.state, args.worktreeId)
  const isLocalSession =
    !args.session.executionHostId || args.session.executionHostId === LOCAL_EXECUTION_HOST_ID
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
    | 'activeRepoId'
    | 'activeWorktreeId'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'projects'
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
  >,
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
