// RA-11d / RA-11e: what a cloud Restart launches when the pane recorded nothing, or when the fresh
// command can't be built.
import { useAppStore } from '@/store'
import { ORCA_CLOUD_SESSION_ENV_REFRESH } from './cloud-restart-session-env'
import { resolveTuiAgentLaunchRawArgs } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

/**
 * RA-11d: the launch args a pane with nothing recorded restarts with, when the person set default args. They
 * go through the same launch-profile projection a fresh launch uses (configured Arguments plus the permission
 * choice), so a Restart keeps e.g. `--dangerously-skip-permissions`; the host takes explicit agentArgs
 * verbatim and only projects its own profile when none are sent (RST-FLAGS). No default args set: undefined,
 * and the host's own projection applies as before. The host is a Linux sandbox, so posix quoting.
 */
export function defaultLaunchConfig(
  agent: AccountRestartAgent
): SleepingAgentLaunchConfig | undefined {
  const settings = useAppStore.getState().settings
  if (!settings?.agentDefaultArgs?.[agent]?.trim()) {
    return undefined
  }
  const agentArgs = resolveTuiAgentLaunchRawArgs(agent, settings, undefined, 'posix').trim()
  return agentArgs ? { agentArgs, agentEnv: {} } : undefined
}

/** The fresh command; if it can't be built from settings, the agent's plain launch after the env refresh. */
export function freshCommandFor(build: () => string, agent: AccountRestartAgent): string {
  try {
    return build()
  } catch (err) {
    console.warn('[orca-cloud] RA-11e fresh command fell back to the plain launch:', err)
    return `${ORCA_CLOUD_SESSION_ENV_REFRESH}${agent}`
  }
}
