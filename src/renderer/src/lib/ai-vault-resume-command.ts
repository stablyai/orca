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
import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'

type AiVaultResumeCommandSession = Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'>

export type AiVaultResumeStartup = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
}

export function buildAiVaultResumeCommandForWorktree(args: {
  state: Pick<
    AppState,
    'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
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
    'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
  >
  worktreeId?: string | null
  session: AiVaultResumeCommandSession
  commandOverride?: string | null
}): AiVaultResumeStartup {
  const platform = getAiVaultResumePlatform(args.state, args.worktreeId)
  const codexHome = getAiVaultResumeCodexHome(args.session.codexHome, platform)
  if (isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: { key: 'session_id', id: args.session.sessionId },
      cmdOverrides: {
        ...args.state.settings?.agentCmdOverrides,
        ...(args.commandOverride?.trim() ? { [args.session.agent]: args.commandOverride } : {})
      },
      platform,
      // Why: copied AI Vault commands are shell-wrapped for portability; the
      // same inner command must be queued so drag/click resume match copy.
      shell: platform === 'win32' ? 'cmd' : undefined,
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
          codexHome
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
      cwd: args.session.cwd,
      platform,
      commandOverride: args.commandOverride,
      codexHome
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
