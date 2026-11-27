import { getAgentForkArgv, getAgentResumeArgv } from './agent-resume-argv'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent
} from '../../agent-session/lifecycle/agent-session-resume'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { buildSleepingAgentLaunchConfig } from '../../agent-session/lifecycle/resume/sleeping-agent-launch-config'
import { resolveAgentLaunchCommand, withAgentTerminalInputArgs } from './tui-agent-launch-command'
import { startupUpdatePromptSuppression } from './agent-startup-update-prompt'
import type { AgentStartupPlan } from './tui-agent-startup'
import {
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'
import { buildAiVaultResumeShellCommand } from '../../ai-vault/resume/ai-vault-resume-command'
import { normalizeRuntimePathForComparison } from '../../file-access/cross-platform-path'
import { parseWslUncPath } from '../../file-access/wsl-paths'
import { dropRecordedAgentPermissionArgs } from '../permissions/tui-agent-permission-lift'

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
  const resolvedAgentCommand = recorded.agentCommand?.trim()
  const baseCommand = resolvedAgentCommand
    ? ({
        ok: true,
        command: withAgentTerminalInputArgs(
          resolvedAgentCommand,
          args.agent,
          args.agentHostPlatform === undefined ? args.platform : args.agentHostPlatform,
          shell
        ),
        resumeLaunch: { agentCommand: resolvedAgentCommand },
        appliedSessionOptions: {}
      } as const)
    : resolveAgentLaunchCommand({
        agent: args.agent,
        cmdOverrides: args.cmdOverrides,
        platform: args.platform,
        shell,
        agentArgs: recorded.agentArgs,
        sessionOptions: args.sessionOptions,
        sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
        isRemote: args.isRemote,
        agentHostPlatform: args.agentHostPlatform
      })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentArgs: recorded.agentArgs,
    ...baseCommand.resumeLaunch
  })
  // Orca starts every resume and often types into it, so an update screen must not take that Enter.
  const suppression = startupUpdatePromptSuppression(args.agent)
  const suppressedCommand = suppression.args.length
    ? `${baseCommand.command} ${suppression.args.map((arg) => quoteStartupArg(arg, shell)).join(' ')}`
    : baseCommand.command
  const resumeCommand = buildAgentResumeLaunchCommand(args.agent, suppressedCommand, argv, shell)
  const env = suppression.env ? { ...args.agentEnv, ...suppression.env } : args.agentEnv
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
    ...(env ? { env: { ...env } } : {})
  }
}

/** WSL panes start at a UNC path while the agent reports its Linux path. */
function isSameFolder(agentCwd: string, launchCwd: string): boolean {
  const launchPath = parseWslUncPath(launchCwd)?.linuxPath ?? launchCwd
  return (
    normalizeRuntimePathForComparison(agentCwd) === normalizeRuntimePathForComparison(launchPath)
  )
}
