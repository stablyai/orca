import { resolveAgentStartupPlanInputs } from '../../agent-launch/startup/agent-startup-plan-inputs'
import { resolveAgentLaunchCommand } from '../../agent-launch/startup/tui-agent-launch-command'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../agent-launch/startup/tui-agent-startup-shell'
import { buildSleepingAgentLaunchConfig } from '../../agent-session/lifecycle/resume/sleeping-agent-launch-config'
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
  // A reference carries no launch prompt. Resolve the command without the fresh prompt builders.
  const inputs = resolveAgentStartupPlanInputs({
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
  })
  const plan = resolveAgentLaunchCommand({
    ...inputs,
    shell: resolveStartupShell(args.platform, inputs.shell)
  })
  if (!plan.ok) {
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
      commandOverride: plan.command
    }),
    env: { ...inputs.agentEnv, ...plan.startupEnv },
    launchConfig: buildSleepingAgentLaunchConfig({ ...inputs, ...plan.resumeLaunch })
  }
}
