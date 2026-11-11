// RA-11d / RA-11e: what a cloud Restart launches when the pane recorded nothing, or when the fresh
// command can't be built.
import { useAppStore } from '@/store'
import { ORCA_CLOUD_SESSION_ENV_REFRESH } from './cloud-restart-session-env'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

export function defaultLaunchConfig(
  agent: AccountRestartAgent
): SleepingAgentLaunchConfig | undefined {
  const agentArgs = useAppStore.getState().settings?.agentDefaultArgs?.[agent]?.trim()
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
