import type { RuntimeRelayConnection } from './runtime-relay-connection'
import type { KnownRuntimeEnvironment, RuntimeEnvironmentSource } from './runtime-environments'

export type AddEnvironmentArgs = {
  relayConnection?: RuntimeRelayConnection
  name: string
  pairingCode: string
  now?: number
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
  /** Recorded only when the code turns out to be for an already saved server. */
  runtimeId?: string
}

export type AddEnvironmentOutcome = {
  environment: KnownRuntimeEnvironment
  /** The code was for a saved server, whose pairing it replaced instead of adding a second entry. */
  updatedExisting: boolean
}

export type UpdateEnvironmentPairingArgs = {
  pairingCode: string
  now?: number
  runtimeId?: string
  relayConnection?: RuntimeRelayConnection
}

export type ReplaceEnvironmentPairingOptions = {
  now: number
  runtimeId?: string
  connectionDependency?: 'ssh-tunnel'
  relayConnection?: RuntimeRelayConnection
}
