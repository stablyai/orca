import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { parseRuntimeRelayEndpoint } from '../pairing/runtime-relay-endpoint'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { RelayClientPlatform } from '../relay/client/relay-client-platform'
import { PairedE2EEAuthenticationError } from '../relay/client/paired-e2ee-v2-physical-channel'
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
import { createRelayCredentialCalls } from './remote-runtime-relay-credential-calls'

/**
 * What a dial presents: the host's invite, the installed resume credential, or a resume credential
 * whose install may have committed before the link dropped (its version unknown until it answers).
 */
type RelayRuntimeDial = SharedHostRelayCredential | { kind: 'pending-resume'; token: string }

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
    const dial = entry ? credentialToDial(entry, Date.now()) : null
    if (!entry || !dial) {
      return { ok: false, error: credentialUnavailableError() }
    }
    return {
      ok: true,
      channel: openRelayRuntimeChannel(connection, config, entry, dial, events)
    }
  }
}

function credentialToDial(entry: SharedHostLinkEntry, now: number): RelayRuntimeDial | null {
  if (entry.resume) {
    return { kind: 'resume', token: entry.resume.token, version: entry.resume.version }
  }
  if (entry.pendingResume) {
    return { kind: 'pending-resume', token: entry.pendingResume.token }
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
  dial: RelayRuntimeDial,
  events: AuthenticatedRuntimeChannelEvents
) {
  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let ready = false
  const calls = createRelayCredentialCalls(connection.credential.deviceToken, (payload) =>
    link.sendText(payload)
  )
  const shut = (): void => {
    state = 'closed'
    calls.failAll(new Error('relay link closed'))
    link.close()
  }
  const end = (error: RemoteRuntimeClientError, close?: { code: number; reason: string }): void => {
    if (state !== 'closed') {
      shut()
      events.onClosed(error, close ? 'socket_close' : 'protocol_error', close)
    }
  }
  // A closed link's credential work must not overwrite what a newer link keeps.
  const liveStore = {
    entry: config.store.entry,
    save: (next: SharedHostLinkEntry) => {
      if (state !== 'closed') {
        config.store.save(next)
      }
    },
    randomBytes: config.randomBytes,
    newId: config.newId
  }
  const relay = entry.resume?.relay ?? entry.offer!.relay
  const link = new RelayE2eeLink({
    platform: config.platform,
    endpoint: { cellUrl: relay.cellUrl, relayHostId: relay.relayHostId },
    ...(dial.kind === 'invite'
      ? { credential: dial.inviteToken, expectedCredentialKind: 'invite' as const }
      : { credential: dial.token, expectedCredentialKind: 'resume' as const }),
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
        dial.kind === 'resume' &&
        (hello.credentialKind !== 'resume' || hello.acceptedCredentialVersion !== dial.version)
      ) {
        // Never dialed again: Relay holds another credential for this computer.
        const current = config.store.entry()
        if (current) {
          config.store.save(withoutRefusedDial(current, dial))
        }
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
      // Invite, or an install that may have committed: install (idempotent per reqId) before
      // anything else. Resume: renew alongside.
      const mode = dial.kind === 'resume' ? 'renew' : 'install'
      const kept = keepRelayResumeCredential(calls.port, mode, liveStore, 'runtime')
      const becomeReady = (): void => {
        if (state !== 'closed' && !ready) {
          ready = true
          events.onAuthenticated()
        }
      }
      if (mode === 'renew') {
        becomeReady()
        // Like the share link: a failed renewal is logged; the next dial confirms again.
        void kept.catch((error: unknown) => {
          if (state !== 'closed') {
            console.warn('[remote-runtime] Relay resume renewal failed', errorMessage(error))
          }
        })
        return
      }
      void kept.then(becomeReady, (error: unknown) => {
        // Admitted, yet the host can't confirm the install: drop it rather than redial it forever.
        const current = dial.kind === 'pending-resume' ? config.store.entry() : undefined
        if (current && state !== 'closed') {
          config.store.save(withoutRefusedDial(current, dial))
        }
        end(
          new RemoteRuntimeClientError(
            'relay_credential_install_failed',
            `Could not keep this server's Relay pairing: ${errorMessage(error)}`
          )
        )
      })
    },
    onText: (plaintext) => {
      events.onAnswer()
      events.onActivity?.()
      if (!calls.answer(plaintext) && ready) {
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
        const next = current ? withoutRefusedDial(current, dial) : undefined
        if (next) {
          config.store.save(next)
        }
        if (!next || !credentialToDial(next, Date.now())) {
          // Nothing left to present: say so now, so the connection stops instead of redialing.
          end(credentialUnavailableError())
          return
        }
      }
      if (error instanceof PairedE2EEAuthenticationError) {
        // The host itself refused this device (revoked or unknown): its pairing owner recovers.
        end(new RemoteRuntimeClientError('unauthorized', error.message))
        return
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
    close: shut
  }
}

/** A refused pending resume never committed: drop it, so the next dial installs on the invite. */
function withoutRefusedDial(entry: SharedHostLinkEntry, dial: RelayRuntimeDial) {
  return dial.kind === 'pending-resume'
    ? { ...entry, pendingResume: undefined }
    : withoutRefusedCredential(entry, dial)
}

function credentialUnavailableError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'relay_credential_unavailable',
    'This server can be reached only over Relay, and its pairing has expired. Pair it again.'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
