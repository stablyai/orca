import { resolveAgentStartupPlanInputs } from '../../agent-launch/startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../agent-launch/startup/tui-agent-startup'
import type { AgentStartupShell } from '../../agent-launch/startup/tui-agent-startup-shell'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'
import type { ManagedAgentCommands } from '../../agent-launch/startup/managed-agent-launch-program'
import type { AiVaultResumeLaunchSettings, AiVaultResumeStartup } from './ai-vault-resume-startup'

/** References are fresh launches, so preserve normal model arguments and environment. */
export function buildAntigravityReferenceStartup(args: {
  session: { sessionId: string; filePath?: string }
  cwd: string | null
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  commandOverride?: string | null
  settings?: AiVaultResumeLaunchSettings | null
  managedAgentCommands?: ManagedAgentCommands
}): AiVaultResumeStartup | null {
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'antigravity',
      platform: args.platform,
      shell: args.shell,
      isRemote: false,
      settings: {
        ...args.settings,
        agentCmdOverrides: {
          ...args.settings?.agentCmdOverrides,
          ...(args.commandOverride?.trim() ? { antigravity: args.commandOverride } : {})
        }
      },
      managedAgentCommands: args.managedAgentCommands
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  if (!plan) {
    return null
  }
  return {
    command: buildAiVaultResumeCommand({
      agent: 'antigravity',
      sessionId: args.session.sessionId,
      resumeFilePath: args.session.filePath,
      cwd: args.cwd,
      platform: args.platform,
      shell: args.shell,
      commandOverride: plan.launchCommand
    }),
    ...(plan.env ? { env: plan.env } : {}),
    launchConfig: plan.launchConfig
  }
}
