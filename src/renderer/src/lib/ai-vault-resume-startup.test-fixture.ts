import { buildAgentTerminalResumePlan } from '../../../shared/agent-terminal-resume-plan'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { AiVaultResumeStartup as PreparedStartup } from '../../../shared/ai-vault-resume-startup'
import {
  resolveAiVaultResumeHost,
  type AiVaultResumeStartup,
  type AiVaultResumeWorktreeArgs
} from './ai-vault-resume-command'

/** Exercise the same command assertions after the typed request reaches its execution host. */
export function materializeAiVaultResumeForTest(
  args: AiVaultResumeWorktreeArgs,
  startup: AiVaultResumeStartup
): PreparedStartup {
  if (!startup.resume) {
    return startup
  }
  if (!isResumableTuiAgent(args.session.agent) || !startup.providerSession) {
    throw new Error('Missing resume identity')
  }
  const host = resolveAiVaultResumeHost(args)
  const { resume, ...rest } = startup
  const plan = buildAgentTerminalResumePlan({
    agent: args.session.agent,
    providerSession: startup.providerSession,
    resume,
    settings: args.state.settings ?? {},
    isRemote: Boolean(args.session.executionHostId && args.session.executionHostId !== 'local'),
    runtime: {
      platform: host.platform,
      pty: {
        shellOverride:
          host.liveShell === 'cmd'
            ? 'cmd.exe'
            : host.liveShell === 'posix'
              ? 'git-bash'
              : undefined,
        terminalWindowsWslDistro: null
      }
    },
    launchCwd: startup.cwd
  })
  if (!plan) {
    throw new Error('Missing resume plan')
  }
  return {
    ...rest,
    command: plan.launchCommand,
    launchConfig: plan.launchConfig,
    env: { ...plan.env, ...startup.env }
  }
}
