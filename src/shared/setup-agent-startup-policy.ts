import type { SetupAgentStartupPolicy } from './orca-yaml-hook-types'

// Why: existing repos keep launching setup and agents side by side unless the user or
// committed project config requires setup to finish first.
export const DEFAULT_SETUP_AGENT_STARTUP_POLICY: SetupAgentStartupPolicy = 'start-immediately'

export function shouldWaitForSetupBeforeAgentStartup(
  ...policies: (SetupAgentStartupPolicy | undefined)[]
): boolean {
  return policies.includes('wait-for-setup')
}
