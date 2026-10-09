import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import {
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from '../../../shared/ai-vault-resume-command'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  getAiVaultAgentProviderSession,
  resolveAiVaultResumeHost,
  type AiVaultResumeStartup,
  type AiVaultResumeWorktreeArgs
} from '@/lib/ai-vault-resume-command'

/**
 * A terminal session that starts from a copy of a conversation a native chat owns.
 *
 * Null when the agent cannot fork: a plain resume in its place would make the terminal a second
 * writer on the chat's conversation. No `providerSession` either: the copy gets its own id, and a
 * cold restore of this tab must never re-enter the chat's conversation.
 */
export function buildAiVaultForkStartupForWorktree(
  args: AiVaultResumeWorktreeArgs
): AiVaultResumeStartup | null {
  const { session, state } = args
  const providerSession = getAiVaultAgentProviderSession(session)
  if (!providerSession || !isResumableTuiAgent(session.agent)) {
    return null
  }
  const { platform, codexHome, liveShell } = resolveAiVaultResumeHost(args)
  const plan = buildAgentResumeStartupPlan({
    agent: session.agent,
    providerSession,
    cmdOverrides: {
      ...state.settings?.agentCmdOverrides,
      ...(args.commandOverride?.trim() ? { [session.agent]: args.commandOverride } : {})
    },
    platform,
    shell: liveShell,
    agentArgs: resolveTuiAgentLaunchArgs(session.agent, state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(session.agent, state.settings?.agentDefaultEnv),
    resumeInLaunchCwd: true,
    fork: true
  })
  if (!plan) {
    return null
  }
  return {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: null,
      platform,
      codexHome,
      shell: liveShell
    }),
    ...(plan.env ? { env: plan.env } : {}),
    ...realHomeCodexResumeEnvDeletion(session),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    launchConfig: plan.launchConfig
  }
}
