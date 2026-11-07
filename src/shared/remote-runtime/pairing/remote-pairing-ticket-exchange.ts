import type { PairingOffer } from './mobile-relay-pairing-offer'
import { encodePairingOffer } from './pairing'
import { pairedRuntimeConnectionFromOffer } from './paired-runtime-connection'
import {
  EXCHANGE_PAIRING_TICKET_METHOD,
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
} from './ticket-exchange-capability'
import { sendRemoteRuntimeRequest } from '../remote-runtime-client'

const EXCHANGE_TIMEOUT_MS = 10_000

function randomHexToken(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Swap an access link's pairing token for one generated here, returning the pairing code to save.
 * The host keeps accepting the link until this client first signs in with the new token, so any
 * failure (older host, refusal, timeout) returns the original code unchanged.
 */
export async function exchangeRemotePairingTicket(args: {
  pairingCode: string
  offer: PairingOffer
  hostCapabilities: readonly string[] | undefined
  send?: typeof sendRemoteRuntimeRequest
  timeoutMs?: number
}): Promise<string> {
  if (!args.hostCapabilities?.includes(PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY)) {
    return args.pairingCode
  }
  const deviceToken = randomHexToken()
  const send = args.send ?? sendRemoteRuntimeRequest
  try {
    const response = await send(
      pairedRuntimeConnectionFromOffer(args.offer),
      EXCHANGE_PAIRING_TICKET_METHOD,
      { deviceToken },
      args.timeoutMs ?? EXCHANGE_TIMEOUT_MS
    )
    if (!response.ok) {
      return args.pairingCode
    }
    const exchanged = { ...args.offer, deviceToken }
    // Sign in once now so the host retires the link immediately; a host downgraded before this
    // client's first later use would not know the new token. The host already stored it, so a
    // failure here still leaves the new token working.
    await send(
      pairedRuntimeConnectionFromOffer(exchanged),
      'status.get',
      undefined,
      args.timeoutMs ?? EXCHANGE_TIMEOUT_MS
    ).catch(() => undefined)
    return encodePairingOffer(exchanged)
  } catch {
    return args.pairingCode
  }
}
