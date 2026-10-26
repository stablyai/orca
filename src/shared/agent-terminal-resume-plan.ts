import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'
import type { AgentTerminalResume } from './agent-terminal-resume'
import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import { resolveResumeLaunchRecipe } from './tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import type { AgentLaunchRuntime } from './agent-launch-runtime'
import { agentLaunchQuotingShell } from './agent-launch-runtime'
import type { SessionOptionValue } from './native-chat-session-options'
import { buildAiVaultResumeShellCommand } from './ai-vault-resume-command'
import { parseWslUncPath } from './wsl-paths'

export function buildAgentTerminalResumePlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  resume: AgentTerminalResume
  settings: AgentStartupSettings
  runtime: AgentLaunchRuntime
  isRemote: boolean
  launchCwd?: string
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
}) {
  const { recipe } = args.resume
  const shell = agentLaunchQuotingShell(args.runtime)
  const settings = recipe.source === 'current-inputs' ? recipe.settings : args.settings
  const inputs =
    recipe.source === 'saved'
      ? resolveResumeLaunchRecipe(recipe.launchConfig)
      : resolveAgentStartupPlanInputs({
          agent: args.agent,
          settings,
          platform: args.runtime.platform,
          shell,
          isRemote: args.isRemote,
          ...(recipe.source === 'current-inputs' && recipe.agentArgs !== undefined
            ? { agentArgs: recipe.agentArgs }
            : args.agentArgs !== undefined
              ? { agentArgs: args.agentArgs }
              : {}),
          sessionOptions: args.sessionOptions
        })
  const plan = buildAgentResumeStartupPlan({
    agent: args.agent,
    providerSession: {
      ...args.providerSession,
      ...(args.providerSession.transcriptPath
        ? {
            transcriptPath: normalizeAiVaultResumeFilePath(
              args.providerSession.transcriptPath,
              args.runtime.platform
            )
          }
        : {})
    },
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: inputs.agentArgs,
    agentEnv: inputs.agentEnv,
    ...(recipe.source === 'saved' && recipe.launchConfig?.agentCommand
      ? { agentCommand: recipe.launchConfig.agentCommand }
      : {}),
    platform: args.runtime.platform,
    shell,
    isRemote: args.isRemote,
    ompResumeFilePath: normalizeAiVaultResumeFilePath(
      args.resume.ompResumeFilePath ??
        (recipe.source === 'saved' ? recipe.launchConfig?.ompResumeFilePath : undefined),
      args.runtime.platform
    ),
    sessionOptions: args.sessionOptions,
    sessionOptionsOverrideAgentArgs: Boolean(args.sessionOptions),
    launchCwd: args.launchCwd,
    resumeInLaunchCwd: args.resume.resumeInLaunchCwd
  })
  if (!plan || !args.resume.codexHome) {
    return plan
  }
  const home =
    args.runtime.platform === 'linux'
      ? (parseWslUncPath(args.resume.codexHome)?.linuxPath ?? args.resume.codexHome)
      : args.resume.codexHome
  return {
    ...plan,
    launchCommand: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: null,
      platform: args.runtime.platform,
      shell,
      codexHome: home
    })
  }
}
