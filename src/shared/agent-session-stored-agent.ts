/** The identity an agent must match when starting a stored session. */

import type { AgentSessionProviderTransport } from './agent-session-provider-handle'

/** What an agent's definition says its records pin. */
export type AgentSessionStoredAgent = {
  /** The Orca agent a record names as its `provider`. */
  agent: string
  /** The protocol whose id space this agent's provider handles live in. */
  handleTransport: AgentSessionProviderTransport
} & (
  | {
      /** Environment variable naming the agent's config directory, pinned as the record's account home. */
      accountHomeVariable: string
      accountLocatorKind?: never
    }
  | {
      /** The agent's account is more than one directory: its records pin a tagged locator of this
       *  kind instead (`AgentSessionAccountHome`). */
      accountLocatorKind: 'opencode'
      accountHomeVariable?: never
    }
)
