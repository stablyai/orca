import type { AgentObservationGroup } from '@/lib/agent-session/launch/inventory/useDetectedAgents'

export type AgentMenuObservationOptions = {
  /** `open` is the user opening this picker, a user act that may start its WSL distro. */
  wakeOnOpen?: boolean
  offerAgentSetup?: boolean
  /** The tab group whose launch surface this is; its observed hosts survive a layout remount. */
  observationGroup?: AgentObservationGroup
}
