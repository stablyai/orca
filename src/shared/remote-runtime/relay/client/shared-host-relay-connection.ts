import {
  connectRelayRpcClient,
  type RelayRpcClient,
  type RelayRpcClientEvents
} from './relay-rpc-client'
import type { RelayClientPlatform } from './relay-client-platform'

export type SharedHostRelayCredential =
  | { kind: 'invite'; inviteToken: string }
  | { kind: 'resume'; token: string; version: number }

/**
 * A shared host: another person's Orca, reached over Orca Relay with a device key it granted this
 * device. Unlike a paired host there is no device token; the authenticated socket is the principal.
 */
export type SharedHostConnection = {
  kind: 'shared-host'
  relay: { cellUrl: string; relayHostId: string }
  hostPublicKeyB64: string
  deviceId: string
  relayCredential: SharedHostRelayCredential
}

export function connectSharedHost(
  args: {
    platform: RelayClientPlatform
    connection: SharedHostConnection
    // Signs the host's auth proof with this device's key; the private key never leaves the caller.
    sign: (message: Uint8Array) => Promise<Uint8Array>
    requestTimeoutMs?: number
  },
  events: RelayRpcClientEvents = {}
): RelayRpcClient {
  const { connection } = args
  const { relayCredential } = connection
  return connectRelayRpcClient(
    {
      platform: args.platform,
      endpoint: connection.relay,
      ...(relayCredential.kind === 'invite'
        ? { credential: relayCredential.inviteToken, expectedCredentialKind: 'invite' }
        : {
            credential: relayCredential.token,
            expectedCredentialKind: 'resume',
            expectedResumeVersion: relayCredential.version
          }),
      authCredential: { kind: 'device-key', deviceId: connection.deviceId, sign: args.sign },
      desktopPublicKeyB64: connection.hostPublicKeyB64,
      requestTimeoutMs: args.requestTimeoutMs
    },
    events
  )
}
