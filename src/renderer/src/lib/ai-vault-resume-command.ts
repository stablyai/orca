import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion,
  stripAiVaultResumeCwdPrefix
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
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { AppState } from '@/store/types'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { aiVaultResumeCwdExists, resolveAiVaultResumeCwd } from './ai-vault-resume-cwd'
import {
  getAiVaultAgentProviderSession,
  getAiVaultResumeCodexHome,
  getAiVaultResumePlatform,
  resolveAiVaultResumeShell
} from './ai-vault-resume-runtime'

export { getAiVaultResumeWorkspacePath } from './ai-vault-resume-cwd'
export {
  getAiVaultAgentProviderSession,
  getAiVaultResumeCodexHome,
  getAiVaultResumePlatform
} from './ai-vault-resume-runtime'

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

export async function buildAiVaultResumeCopyCommandForWorktreeAsync(
  args: AiVaultResumeWorktreeArgs
): Promise<string> {
  const platform = getAiVaultResumeWorktreePlatform(args)
  const sessionCwdExists = await aiVaultResumeCwdExists({
    state: args.state,
    worktreeId: args.worktreeId ?? args.state.activeWorktreeId ?? '',
    sessionCwd: args.session.cwd,
    platform
  })
  const clearEnvNames =
    args.session.agent === 'codex' && args.session.codexHome === null
      ? (['CODEX_HOME', 'ORCA_CODEX_HOME'] as const)
      : undefined
  return buildAiVaultResumeForWorktree(args, true, clearEnvNames, sessionCwdExists).command
}

export function buildAiVaultResumeStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeForWorktree(args, false)
}

export async function buildAiVaultResumeStartupForWorktreeAsync(
  args: AiVaultResumeWorktreeArgs
): Promise<AiVaultResumeStartup> {
  const platform = getAiVaultResumeWorktreePlatform(args)
  const sessionCwdExists = await aiVaultResumeCwdExists({
    state: args.state,
    worktreeId: args.worktreeId ?? args.state.activeWorktreeId ?? '',
    sessionCwd: args.session.cwd,
    platform
  })
  return buildAiVaultResumeForWorktree(args, false, undefined, sessionCwdExists)
}

function getAiVaultResumeWorktreePlatform(args: AiVaultResumeWorktreeArgs): NodeJS.Platform {
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.executionHostPlatform
  ) {
    return args.session.executionHostPlatform
  }
  return getAiVaultResumePlatform(args.state, args.worktreeId)
}

function buildAiVaultResumeForWorktree(
  args: AiVaultResumeWorktreeArgs,
  embedCwd: boolean,
  /** Copy-path only: names the pasted line must strip off the agent itself.
   *  Spawned startups drop them through `envToDelete` instead. */
  clearEnvNames?: readonly string[],
  sessionCwdExists?: boolean
): AiVaultResumeStartup {
  const providerSession = getAiVaultAgentProviderSession(args.session)
  const platform = getAiVaultResumeWorktreePlatform(args)
  const isLocalSession =
    !args.session.executionHostId || args.session.executionHostId === LOCAL_EXECUTION_HOST_ID
  // Why: local shell settings do not describe a remote Windows host, whose
  // queued resume command uses the remote default PowerShell syntax.
  const liveShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? isLocalSession
        ? resolveAiVaultResumeShell({
            state: args.state,
            worktreeId: args.worktreeId,
            sessionExecutionHostId: args.session.executionHostId
          })
        : 'powershell'
      : undefined
  const resumeCwd = resolveAiVaultResumeCwd({
    state: args.state,
    worktreeId: args.worktreeId,
    sessionCwd: args.session.cwd,
    platform,
    sessionCwdExists
  })
  if (
    args.session.executionHostId &&
    args.session.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
    args.session.resumeCommand &&
    args.session.agent !== 'omp' &&
    !(args.session.agent === 'codex' && args.session.codexHome === null) &&
    !args.commandOverride?.trim()
  ) {
    const staleCwd = resumeCwd !== args.session.cwd
    const resumeCommand = staleCwd
      ? stripAiVaultResumeCwdPrefix({
          resumeCommand: args.session.resumeCommand,
          cwd: args.session.cwd,
          platform
        })
      : args.session.resumeCommand
    const command =
      embedCwd && staleCwd
        ? buildAiVaultResumeShellCommand({
            resumeCommand,
            cwd: resumeCwd,
            platform,
            // Copied commands must remain self-contained for the remote host's default shell.
            shell: undefined
          })
        : resumeCommand
    return {
      command,
      ...realHomeCodexResumeEnvDeletion(args.session),
      ...(!embedCwd && staleCwd && resumeCwd ? { cwd: resumeCwd } : {}),
      ...(providerSession ? { providerSession } : {})
    }
  }
  const codexHome = getAiVaultResumeCodexHome(args.session.codexHome, platform)
  const resumeFilePath = normalizeAiVaultResumeFilePath(args.session.filePath, platform)
  const cwd = embedCwd ? resumeCwd : null
  const startupCwd = !embedCwd && resumeCwd ? { cwd: resumeCwd } : {}
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
