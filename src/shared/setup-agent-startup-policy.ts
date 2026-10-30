import type { SetupAgentStartupPolicy } from './orca-yaml-hook-types'

// Existing repos launch setup/agents in parallel unless user/project config requires sequencing.
export const DEFAULT_SETUP_AGENT_STARTUP_POLICY: SetupAgentStartupPolicy = 'start-immediately'
export const DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS = 2 * 60 * 60

export function shouldWaitForSetupBeforeAgentStartup(
  ...policies: (SetupAgentStartupPolicy | undefined)[]
): boolean {
  return policies.includes('wait-for-setup')
}
