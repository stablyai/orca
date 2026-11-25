import type { GlobalSettings } from './global-settings-types'

export const DEFAULT_EXPERIMENTAL_SETTINGS = {
  // Why: off keeps the cosmetic overlay unmounted for users who never opt in.
  experimentalPet: false,
  experimentalActivity: false,
  experimentalActivityDefaultedOffForAllUsers: true,
  experimentalTerminalAttention: false,
  experimentalAgentHibernation: false,
  experimentalSharedCodexServers: false,
  agentHibernationIdleMs: 30 * 60 * 1000,
  experimentalNewWorktreeCardStyle: true,
  experimentalAppRail: true,
  experimentalEphemeralVms: false,
  experimentalWslHosts: false,
  experimentalOrchestrationPanel: false
} satisfies Partial<GlobalSettings>
