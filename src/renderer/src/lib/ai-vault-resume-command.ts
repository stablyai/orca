import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion,
  type AiVaultSession
} from '../../../shared/ai-vault-types'
import {
  isResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import {
  clearEnvCommand,
  commandSeparator,
  resolveStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type AiVaultResumeCommandSession = Pick<
  AiVaultSession,
  'agent' | 'sessionId' | 'cwd' | 'codexHome'
> &
  Partial<
    Pick<AiVaultSession, 'executionHostId' | 'executionHostPlatform' | 'resumeCommand' | 'filePath'>
  >

export type AiVaultResumeStartup = {
  command: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
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
  const command = buildAiVaultResumeForWorktree(args).command
  if (args.session.agent !== 'codex' || args.session.codexHome !== null) {
    return command
  }
  const shell = resolveAiVaultResumeShell(args)
  const separator = commandSeparator(shell)
  const clearHomes = ['CODEX_HOME', 'ORCA_CODEX_HOME']
    .map((name) => clearEnvCommand(name, shell))
    .join(separator)
  return `${clearHomes}${separator}${command}`
}

export function buildAiVaultResumeStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeForWorktree(args)
}

function buildAiVaultResumeForWorktree(args: AiVaultResumeWorktreeArgs): AiVaultResumeStartup {
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    !(args.session.agent === 'codex' && args.session.codexHome === null) &&
    !args.commandOverride?.trim()
  ) {
    return {
      command: args.session.resumeCommand,
      ...realHomeCodexResumeEnvDeletion(args.session)
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
  // Why: local shell settings do not describe a remote Windows host, whose
  // queued resume command uses the remote default PowerShell syntax.
  const liveShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? isLocalSession
        ? resolveWindowsShellStartupFamily(args.state.settings?.terminalWindowsShell)
        : 'powershell'
      : undefined
  if (isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: { key: 'session_id', id: args.session.sessionId },
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
      agentEnv: resolveTuiAgentLaunchEnv(args.session.agent, args.state.settings?.agentDefaultEnv)
    })
    if (startupPlan) {
      return {
        command: buildAiVaultResumeShellCommand({
          resumeCommand: startupPlan.launchCommand,
          cwd: args.session.cwd,
          platform,
          codexHome,
          shell: liveShell
        }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        ...realHomeCodexResumeEnvDeletion(args.session),
        launchConfig: startupPlan.launchConfig
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
      resumeFilePath: args.session.filePath,
      cwd: args.session.cwd,
      platform,
      commandOverride: args.commandOverride,
      codexHome,
      // Why: non-resumable agents queue through this fallback too, so it must
      // quote for the live Windows shell like the startup-plan branch above.
      shell: liveShell
    }),
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
  const shell =
    platform === 'win32' && isLocalSession
      ? resolveWindowsShellStartupFamily(args.state.settings?.terminalWindowsShell)
      : undefined
  return resolveStartupShell(platform, shell)
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

function getAiVaultResumeWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  return (
    Object.values(state.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)?.path ?? null
  )
}
