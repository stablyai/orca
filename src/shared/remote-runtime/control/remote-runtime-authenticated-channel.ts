import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { SharedControlSocketCloseCause } from './remote-runtime-shared-control-types'

/**
 * What the control connection talks to once a host has authenticated it: plaintext in and out,
 * text and binary. A direct socket owns its own E2EE handshake and token auth; a Relay link owns
 * the cell's handshake and then the same E2EE. Above this, both are the same connection.
 */
export type AuthenticatedRuntimeChannel = {
  /** 'connecting' until the transport opens; 'closed' once it closed, failed or was closed. */
  state: () => 'connecting' | 'open' | 'closed'
  sendText: (plaintext: string) => boolean
  sendBinary: (plaintext: Uint8Array<ArrayBufferLike>) => boolean
  close: () => void
}

export type AuthenticatedRuntimeChannelEvents = {
  /** The transport opened; authentication is still to come. */
  onTransportOpen: () => void
  /** The host answered the opening handshake and the channel is sending its credential. */
  onAuthenticating: () => void
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array<ArrayBufferLike>) => void
  /** Any frame the runtime itself sent, before or after authentication. */
  onAnswer: () => void
  /** Any inbound traffic, transport pings and pongs included. */
  onActivity?: () => void
  onRoundTrip?: (rttMs: number) => void
  /** Once, for any end the channel's owner didn't ask for with close(). */
  onClosed: (
    error: RemoteRuntimeClientError,
    cause: SharedControlSocketCloseCause,
    close?: { code: number; reason: string }
  ) => void
}

export type AuthenticatedRuntimeChannelOpener = (
  events: AuthenticatedRuntimeChannelEvents
) =>
  | { ok: true; channel: AuthenticatedRuntimeChannel }
  | { ok: false; error: RemoteRuntimeClientError }

/**
 * Opener refusals a redial cannot fix: no credential left, one link turned off, or Relay resumed
 * another credential. The connection stops retrying; the next call or a new pairing opens again.
 */
const CHANNEL_REFUSALS_THAT_END_RETRY = new Set([
  'relay_credential_unavailable',
  'relay_one_link_off',
  'relay_credential_mismatch'
])

export function channelRefusalEndsRetry(error: RemoteRuntimeClientError): boolean {
  return CHANNEL_REFUSALS_THAT_END_RETRY.has(error.code)
}
