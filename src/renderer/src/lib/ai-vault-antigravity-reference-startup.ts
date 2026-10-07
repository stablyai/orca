import { isAntigravityReferenceSession } from '../../../shared/antigravity-session-origin'
import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from './ai-vault-resume-target'
import { getAiVaultResumeWorkspaceWslDistro } from './ai-vault-resume-shell'
import { buildAiVaultResumeCommand } from '../../../shared/ai-vault-resume-command'
import { buildAgentStartupPlan } from '../../../shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from '../../../shared/tui-agent-launch-defaults'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  AiVaultResumeStartup,
  buildAiVaultResumeStartupForWorktree
} from './ai-vault-resume-command'

/** References are fresh launches, so preserve normal model arguments and environment. */
export function buildAntigravityReferenceStartup(args: {
  session: { sessionId: string; filePath?: string }
  cwd: string | null
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  commandOverride?: string | null
  settings?:
    | (AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>)
    | null
}): AiVaultResumeStartup | null {
  const plan = buildAgentStartupPlan({
    agent: 'antigravity',
    prompt: '',
    allowEmptyPromptLaunch: true,
    platform: args.platform,
    shell: args.shell,
    cmdOverrides: {
      ...args.settings?.agentCmdOverrides,
      ...(args.commandOverride?.trim() ? { antigravity: args.commandOverride } : {})
    },
    agentArgs: resolveTuiAgentLaunchArgs('antigravity', args.settings, {
      platform: args.platform,
      shell: args.shell
    }),
    agentEnv: resolveTuiAgentLaunchEnv('antigravity', args.settings)
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

export function assertAntigravityReferenceTarget(
  args: Parameters<typeof buildAiVaultResumeStartupForWorktree>[0]
): void {
  const workspaceId = args.worktreeId ?? args.state.activeWorktreeId
  if (
    isAntigravityReferenceSession(args.session) &&
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.session.filePath,
      sessionExecutionHostId: args.session.executionHostId,
      targetStatus: getAiVaultResumeWorkspaceTargetStatus(args.state, workspaceId),
      targetExecutionHostId: getAiVaultResumeWorkspaceExecutionHostId(args.state, workspaceId),
      targetWslDistro: getAiVaultResumeWorkspaceWslDistro(args.state, workspaceId)
    })
  ) {
    throw new Error(
      'The Antigravity transcript belongs to a different execution host or WSL distro.'
    )
  }
}
