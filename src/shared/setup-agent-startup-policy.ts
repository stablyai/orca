import type { SetupAgentStartupPolicy } from './types'

// Why: existing repos should keep launching setup and agents side by side unless
// the user explicitly opts into waiting for setup completion.
export const DEFAULT_SETUP_AGENT_STARTUP_POLICY: SetupAgentStartupPolicy = 'start-immediately'

export function shouldWaitForSetupBeforeAgentStartup(
  policy: SetupAgentStartupPolicy | undefined
): boolean {
  return policy === 'wait-for-setup'
}
