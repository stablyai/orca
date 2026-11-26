import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { parseRuntimeRelayEndpoint } from '../pairing/runtime-relay-endpoint'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { isRpcResponse, type RpcResponse } from '../rpc/rpc-response-shape'
import type { RelayClientPlatform } from '../relay/client/relay-client-platform'
import { RelayE2eeLink, RelayOuterError } from '../relay/client/relay-e2ee-link'
import {
  keepRelayResumeCredential,
  relayRefusedCredential,
  withoutRefusedCredential,
  type SharedHostLinkEntry
} from '../relay/client/shared-host-relay-link'
import type { SharedHostRelayCredential } from '../relay/client/shared-host-relay-connection'
import type {
  AuthenticatedRuntimeChannelEvents,
  AuthenticatedRuntimeChannelOpener
} from './remote-runtime-authenticated-channel'

// Calls this channel makes for its own credential, kept out of the connection's id space.
const CREDENTIAL_CALL_PREFIX = 'relay-credential-'
const CREDENTIAL_CALL_TIMEOUT_MS = 30_000

export type RuntimeRelayCredentialStore = {
  entry: () => SharedHostLinkEntry | undefined
  save: (entry: SharedHostLinkEntry) => void
}

/**
 * A Relay link to a paired runtime as an authenticated channel: the cell's relay-auth and hello,
 * then E2EE and token auth with the host. Like the share link, it pairs on the host's invite,
 * installs a resume credential, then resumes; the control connection above sees only the channel.
 */
export function relayRuntimeChannelOpener(
  connection: PairedRuntimeConnection,
  config: {
    platform: RelayClientPlatform
    store: RuntimeRelayCredentialStore
    clientCapabilities: readonly string[]
    randomBytes: (length: number) => Uint8Array
    newId: () => string
  }
): AuthenticatedRuntimeChannelOpener {
  return (events) => {
    const entry = config.store.entry()
    const credential = entry ? credentialToDial(entry, Date.now()) : null
    if (!entry || !credential) {
      return {
        ok: false,
        error: new RemoteRuntimeClientError(
          'relay_credential_unavailable',
          'This server can be reached only over Relay, and its pairing has expired. Pair it again.'
        )
      }
    }
    return {
      ok: true,
      channel: openRelayRuntimeChannel(connection, config, entry, credential, events)
    }
  }
}

function credentialToDial(
  entry: SharedHostLinkEntry,
  now: number
): SharedHostRelayCredential | null {
  if (entry.resume) {
    return { kind: 'resume', token: entry.resume.token, version: entry.resume.version }
  }
  const invite = entry.offer?.relay
  return invite && invite.inviteExpiresAt > now && invite.inviteToken !== entry.refusedInvite
    ? { kind: 'invite', inviteToken: invite.inviteToken }
    : null
}

function openRelayRuntimeChannel(
  connection: PairedRuntimeConnection,
  config: Parameters<typeof relayRuntimeChannelOpener>[1],
  entry: SharedHostLinkEntry,
  credential: SharedHostRelayCredential,
  events: AuthenticatedRuntimeChannelEvents
) {
  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let ready = false
  let credentialCalls = 0
  const pendingCalls = new Map<string, (response: RpcResponse) => void>()
  const end = (error: RemoteRuntimeClientError, close?: { code: number; reason: string }): void => {
    if (state !== 'closed') {
      state = 'closed'
      link.close()
      events.onClosed(error, close ? 'socket_close' : 'protocol_error', close)
    }
  }
  // The credential calls ride this link before the control connection may use it.
  const port = {
    sendRequest: (method: string, params?: unknown): Promise<RpcResponse> =>
      new Promise((resolve, reject) => {
        const id = `${CREDENTIAL_CALL_PREFIX}${++credentialCalls}`
        const timer = setTimeout(() => {
          pendingCalls.delete(id)
          reject(new Error(`${method} timed out`))
        }, CREDENTIAL_CALL_TIMEOUT_MS)
        pendingCalls.set(id, (response) => {
          clearTimeout(timer)
          resolve(response)
        })
        const deviceToken = connection.credential.deviceToken
        if (!link.sendText(JSON.stringify({ id, deviceToken, method, params }))) {
          clearTimeout(timer)
          pendingCalls.delete(id)
          reject(new Error('relay link closed'))
        }
      })
  }
  const answerCredentialCall = (plaintext: string): boolean => {
    if (!plaintext.includes(CREDENTIAL_CALL_PREFIX)) {
      return false
    }
    let value: unknown
    try {
      value = JSON.parse(plaintext)
    } catch {
      return false
    }
    const answer = isRpcResponse(value) ? pendingCalls.get(value.id) : undefined
    if (!answer || !isRpcResponse(value)) {
      return false
    }
    pendingCalls.delete(value.id)
    answer(value)
    return true
  }
  const relay = entry.resume?.relay ?? entry.offer!.relay
  const link = new RelayE2eeLink({
    platform: config.platform,
    endpoint: { cellUrl: relay.cellUrl, relayHostId: relay.relayHostId },
    ...(credential.kind === 'invite'
      ? { credential: credential.inviteToken, expectedCredentialKind: 'invite' as const }
      : { credential: credential.token, expectedCredentialKind: 'resume' as const }),
    authCredential: connection.credential,
    clientCapabilities: config.clientCapabilities,
    // Token auth over Relay carries capabilities, as a direct socket's does.
    v2TokenCapabilities: true,
    desktopPublicKeyB64: connection.hostPublicKeyB64,
    onOpen: () => {
      state = 'open'
      events.onTransportOpen()
    },
    onHello: (hello) => {
      if (
        credential.kind === 'resume' &&
        (hello.credentialKind !== 'resume' ||
          hello.acceptedCredentialVersion !== credential.version)
      ) {
        end(
          new RemoteRuntimeClientError(
            'relay_credential_mismatch',
            'Relay resumed another credential.'
          )
        )
        return
      }
      events.onAuthenticating()
    },
    onAuthenticated: () => {
      events.onAnswer()
      // Invite: install a resume credential before anything else. Resume: renew it alongside.
      const kept = keepRelayResumeCredential(
        port,
        credential,
        {
          entry: config.store.entry,
          save: config.store.save,
          randomBytes: config.randomBytes,
          newId: config.newId
        },
        'runtime'
      )
      const becomeReady = (): void => {
        if (state !== 'closed' && !ready) {
          ready = true
          events.onAuthenticated()
        }
      }
      if (credential.kind === 'resume') {
        becomeReady()
        void kept.catch(() => {})
        return
      }
      void kept.then(becomeReady, (error: unknown) =>
        end(
          new RemoteRuntimeClientError(
            'relay_credential_install_failed',
            `Could not keep this server's Relay pairing: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      )
    },
    onText: (plaintext) => {
      events.onAnswer()
      events.onActivity?.()
      if (!answerCredentialCall(plaintext) && ready) {
        events.onText(plaintext)
      }
    },
    onBinary: (plaintext) => {
      events.onAnswer()
      events.onActivity?.()
      if (ready) {
        events.onBinary(plaintext)
      }
    },
    onError: (error) => {
      if (relayRefusedCredential(error)) {
        const current = config.store.entry()
        if (current) {
          config.store.save(withoutRefusedCredential(current, credential))
        }
      }
      const code = error instanceof RelayOuterError ? error.code : 1006
      end(
        new RemoteRuntimeClientError('remote_runtime_unavailable', error.message, {
          closeCode: code
        }),
        { code, reason: error.message }
      )
    }
  })
  return {
    state: () => state,
    sendText: (plaintext: string) => ready && link.sendText(plaintext),
    sendBinary: (plaintext: Uint8Array<ArrayBufferLike>) => ready && link.sendBinary(plaintext),
    close: () => {
      state = 'closed'
      link.close()
    }
  }
}

/** The Relay reach a test-paired runtime's endpoint names, as a link entry with its first invite. */
export function runtimeRelayLinkEntry(
  connection: PairedRuntimeConnection
): SharedHostLinkEntry | null {
  const reach = parseRuntimeRelayEndpoint(connection.endpoint)
  return reach && connection.pairedDeviceId
    ? {
        offer: {
          relay: reach,
          hostPublicKeyB64: connection.hostPublicKeyB64,
          deviceId: connection.pairedDeviceId
        }
      }
    : null
}
