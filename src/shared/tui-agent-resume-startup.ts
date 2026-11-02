import { getAgentForkArgv, getAgentResumeArgv } from './agent-resume-argv'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from './agent-session/lifecycle/agent-session-resume'
import type { SessionOptionValue } from './native-chat/input/native-chat-session-options'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { resolveAgentLaunchCommand, withAgentTerminalInputArgs } from './tui-agent-launch-command'
import type { AgentStartupPlan } from './tui-agent-startup'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'
import { buildAiVaultResumeShellCommand } from './ai-vault-resume-command'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'
import {
  dropRecordedAgentPermissionArgs,
  liftAgentPermissionArgs
} from './tui-agent-permission-lift'
import { agentPermissionArgsForLaunch } from './agent-permission-args'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'

export function buildAgentResumeStartupPlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
  ompResumeFilePath?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
  /** The caller chose the terminal folder on purpose, so Codex must not ask for the recorded one. */
  resumeInLaunchCwd?: boolean
  /** Folder the resume shell starts in; an agent recorded elsewhere is resumed from its own folder (#16960). */
  launchCwd?: string | null
  /** Open a copy of the conversation instead of re-entering it; null for agents that cannot. */
  fork?: boolean
  /** OS that runs the agent when `platform` only picks quoting; null when unreported. */
  agentHostPlatform?: NodeJS.Platform | null
}): AgentStartupPlan | null {
  const resumeArgv = args.fork
    ? getAgentForkArgv(args.agent, args.providerSession)
    : getAgentResumeArgv(args.agent, args.providerSession, args.ompResumeFilePath)
  if (!resumeArgv) {
    return null
  }
  // Codex otherwise asks for its old folder, even if deleted (#17745). Keep before resume so argv removal preserves the folder choice.
  const argv =
    args.agent === 'codex' && args.resumeInLaunchCwd
      ? [resumeArgv[0], '-c', 'tui.resume_cwd=current', ...resumeArgv.slice(1)]
      : resumeArgv
  const shell = resolveStartupShell(args.platform, args.shell)
  // Why: Codex restores a resumed thread's saved permissions unless the launch passes one, so
  // replaying Orca's launch-time flag would undo a change made inside the session (#10886).
  const recorded =
    args.agent === 'codex' && !args.fork
      ? dropRecordedAgentPermissionArgs(args.agent, args, shell)
      : args
  const baseCommand = resolveRecipeBaseCommand({ ...args, ...recorded }, shell)
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentArgs: recorded.agentArgs,
    ...baseCommand.resumeLaunch
  })
  const resumeCommand = buildAgentResumeLaunchCommand(args.agent, baseCommand.command, argv, shell)
  const agentCwd = args.providerSession.cwd
  const launchCommand =
    agentCwd && args.launchCwd && !args.resumeInLaunchCwd && !isSameFolder(agentCwd, args.launchCwd)
      ? buildAiVaultResumeShellCommand({
          resumeCommand,
          cwd: agentCwd,
          platform: args.platform,
          shell
        })
      : resumeCommand
  const applied = baseCommand.appliedSessionOptions
  return {
    agent: args.agent,
    launchCommand,
    expectedProcess: TUI_AGENT_CONFIG[args.agent].expectedProcess,
    followupPrompt: null,
    launchConfig,
    ...(args.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
    ...(Object.keys(applied).length > 0 ? { sessionOptions: { ...applied } } : {}),
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

type RecipeLaunchArgs = Pick<
  Parameters<typeof buildAgentResumeStartupPlan>[0],
  | 'agent'
  | 'cmdOverrides'
  | 'platform'
  | 'agentArgs'
  | 'agentCommand'
  | 'sessionOptions'
  | 'sessionOptionsOverrideAgentArgs'
  | 'isRemote'
  | 'agentHostPlatform'
>

function resolveRecipeBaseCommand(args: RecipeLaunchArgs, shell: AgentStartupShell) {
  const agentCommand = args.agentCommand?.trim()
  return agentCommand
    ? ({
        ok: true,
        command: withAgentTerminalInputArgs(
          agentCommand,
          args.agent,
          args.agentHostPlatform === undefined ? args.platform : args.agentHostPlatform,
          shell
        ),
        resumeLaunch: { agentCommand },
        appliedSessionOptions: {}
      } as const)
    : resolveAgentLaunchCommand({ ...args, shell })
}

/** The saved recipe's own launch with no resume locator, for a conversation its agent no longer has.
 *  A resume recipe lost its permission flag (Codex restores a thread's own); a new thread has none
 *  to restore, so it gets the permission any new launch gets unless the recipe names one. */
export function buildAgentRecipeFreshLaunch(
  args: RecipeLaunchArgs & {
    shell?: AgentStartupShell
    agentEnv?: Record<string, string> | null
    permissionSettings?: AgentLaunchProfileSettings | null
  }
): { command: string; launchConfig: SleepingAgentLaunchConfig } | null {
  const shell = resolveStartupShell(args.platform, args.shell)
  const launchPermission =
    args.agent === 'codex' && args.permissionSettings
      ? liftAgentPermissionArgs(
          args.agent,
          resolveTuiAgentLaunchArgs(args.agent, args.permissionSettings)
        ).choice
      : null
  const permission = launchPermission
    ? agentPermissionArgsForLaunch(
        args.agent,
        launchPermission,
        `${args.agentCommand ?? ''} ${args.agentArgs ?? ''}`
      )
    : null
  const withPermission = (text: string | null | undefined) =>
    permission ? `${text?.trim() ?? ''} ${permission}`.trim() : text
  const recipe = {
    ...args,
    agentArgs: withPermission(args.agentArgs),
    agentCommand: args.agentCommand?.trim() ? withPermission(args.agentCommand) : args.agentCommand
  }
  const base = resolveRecipeBaseCommand(recipe, shell)
  return base.ok
    ? {
        command: base.command,
        launchConfig: buildSleepingAgentLaunchConfig({ ...recipe, ...base.resumeLaunch })
      }
    : null
}

/** WSL panes start at a UNC path while the agent reports its Linux path. */
function isSameFolder(agentCwd: string, launchCwd: string): boolean {
  const launchPath = parseWslUncPath(launchCwd)?.linuxPath ?? launchCwd
  return (
    normalizeRuntimePathForComparison(agentCwd) === normalizeRuntimePathForComparison(launchPath)
  )
}
