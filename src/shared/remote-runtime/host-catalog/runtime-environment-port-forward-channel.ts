import type { PortForwardEntry } from '../ssh/ssh-types'

/** Main → renderer: a paired server's forwards to this computer changed. */
export const RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL =
  'runtimeEnvironments:portForwardsChanged'

export type RuntimeEnvironmentPortForwardsChanged = {
  environmentId: string
  forwards: PortForwardEntry[]
}
