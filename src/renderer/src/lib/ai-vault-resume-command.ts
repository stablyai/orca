import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
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
  launchConfig?: SleepingAgentLaunchConfig
}

export function buildAiVaultResumeCommandForWorktree(args: {
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
}): string {
  return buildAiVaultResumeStartupForWorktree(args).command
}

export function buildAiVaultResumeStartupForWorktree(args: {
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
}): AiVaultResumeStartup {
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    !args.commandOverride?.trim()
  ) {
    return { command: args.session.resumeCommand }
  }
  const platform =
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.executionHostPlatform
      ? args.session.executionHostPlatform
      : getAiVaultResumePlatform(args.state, args.worktreeId)
  const codexHome = getAiVaultResumeCodexHome(args.session.codexHome, platform)
  // Why: the queued command is typed verbatim into the freshly spawned tab whose
  // live shell is the configured Windows shell (default PowerShell). Hardcoding
  // cmd quoting made PowerShell mis-parse the `""`-doubled wrapper (#6152), so
  // resolve the actual shell to quote per-shell instead.
  const queuedShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? resolveWindowsShellStartupFamily(args.state.settings?.terminalWindowsShell)
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
      shell: queuedShell,
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
          shell: queuedShell
        }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
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
      shell: queuedShell
    })
  }
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
