import { deriveRelayHostId } from '../relay-host-id'
import type { PairedRuntimeConnection } from '../paired-runtime-connection'
import { RelayPhoneHelloSchema } from '../mobile-relay-phone-protocol'
import { RelayDirectorHttpError, resolveMobileRelayEndpoint } from '../relay-resume-director'
import { RuntimeRelayConnectionSchema } from '../runtime-relay-connection'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { createRemoteRuntimeClientHandshake } from './remote-runtime-client-handshake'

export async function resolveRemoteRuntimeRelay(
  connection: PairedRuntimeConnection
): Promise<void> {
  const relay = connection.relayConnection
  if (!relay || relay.credentialKind !== 'resume') {
    return
  }
  const { credential, credentialKind, ...endpoint } = relay
  try {
    const resolved = await resolveMobileRelayEndpoint({ relay: endpoint, resumeToken: credential })
    connection.relayConnection = { ...resolved, credential, credentialKind }
  } catch (error) {
    throw new RemoteRuntimeClientError(
      error instanceof RelayDirectorHttpError && (error.status === 401 || error.status === 403)
        ? 'unauthorized'
        : 'remote_runtime_unavailable',
      'Could not resolve the Relay host. Check the connection or generate a new access code.',
      { pairingStage: 'connect' }
    )
  }
}

export function createRemoteRuntimeSocketProtocol(connection: PairedRuntimeConnection) {
  const relay = connection.relayConnection
    ? RuntimeRelayConnectionSchema.parse(connection.relayConnection)
    : undefined
  if (relay) {
    const key = Buffer.from(connection.hostPublicKeyB64, 'base64')
    if (
      key.length !== 32 ||
      key.toString('base64') !== connection.hostPublicKeyB64 ||
      deriveRelayHostId(key) !== relay.relayHostId
    ) {
      throw new RemoteRuntimeClientError(
        'invalid_argument',
        'Relay host identity does not match the pairing key.'
      )
    }
  }
  const handshake = createRemoteRuntimeClientHandshake(connection.hostPublicKeyB64, relay)
  let awaitingRelayHello = relay !== undefined
  return {
    handshake,
    endpoint: relay
      ? `${relay.cellUrl.replace(/^https:/, 'wss:')}/v1/connect/${encodeURIComponent(relay.relayHostId)}`
      : connection.endpoint,
    open(send: (frame: string) => void): void {
      send(
        relay
          ? JSON.stringify({
              type: 'relay-auth',
              v: 1,
              mode: 'connect',
              credential: relay.credential
            })
          : handshake.helloText()
      )
    },
    accept(data: string, send: (frame: string) => void): boolean {
      if (!awaitingRelayHello) {
        return false
      }
      let raw: unknown
      try {
        raw = JSON.parse(data)
      } catch {
        throw new RemoteRuntimeClientError('invalid_runtime_response', 'Invalid Relay response.')
      }
      const hello = RelayPhoneHelloSchema.safeParse(raw)
      if (!hello.success) {
        throw new RemoteRuntimeClientError('invalid_runtime_response', 'Invalid Relay hello.')
      }
      if (!hello.data.ok) {
        throw new RemoteRuntimeClientError(
          hello.data.code === 4401 ? 'unauthorized' : 'remote_runtime_unavailable',
          'Relay could not connect to this computer. Check the host or generate a new access code.',
          { closeCode: hello.data.code, pairingStage: 'connect' }
        )
      }
      if (hello.data.credentialKind !== relay?.credentialKind) {
        throw new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Unexpected Relay credential kind.'
        )
      }
      awaitingRelayHello = false
      send(handshake.helloText())
      return true
    }
  }
}

export function openAfterRemoteRuntimeRelayResolution(
  connection: PairedRuntimeConnection,
  ready: () => void,
  failed: (error: RemoteRuntimeClientError) => void
): void {
  const open = (): void => {
    try {
      ready()
    } catch (error) {
      failed(relayRuntimeClientError(error))
    }
  }
  if (!connection.relayConnection) {
    open()
    return
  }
  void resolveRemoteRuntimeRelay(connection).then(open, (error) =>
    failed(relayRuntimeClientError(error))
  )
}

export function relayRuntimeClientError(error: unknown): RemoteRuntimeClientError {
  return error instanceof RemoteRuntimeClientError
    ? error
    : new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        error instanceof Error ? error.message : 'Relay connection failed'
      )
}
