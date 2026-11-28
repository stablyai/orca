import type { PortForwardEntry } from '../ssh/ssh-types'

/** Main → renderer: a paired server's forwards to this computer changed. */
export const RUNTIME_ENVIRONMENT_PORT_FORWARDS_CHANGED_CHANNEL =
  'runtimeEnvironments:portForwardsChanged'

export type RuntimeEnvironmentPortForwardsChanged = {
  environmentId: string
  forwards: PortForwardEntry[]
  /** A restore moved forwards off busy ports here; take them once to tell the person. */
  movesPending?: true
}

/** A restored forward that now listens on another port here, because its own was in use. */
export type RestoredPortForwardMove = {
  environmentId: string
  remotePort: number
  previousLocalPort: number
  localPort: number
}
