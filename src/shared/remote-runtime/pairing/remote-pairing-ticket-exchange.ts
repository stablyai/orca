import type { PairingOffer } from './mobile-relay-pairing-offer'
import { encodePairingOffer } from './pairing'
import {
  type PairedRuntimeConnection,
  pairedRuntimeConnectionFromOffer
} from './paired-runtime-connection'
import {
  EXCHANGE_PAIRING_TICKET_METHOD,
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
} from './ticket-exchange-capability'
import { sendRemoteRuntimeRequestOnSocket } from '../requests/remote-runtime-request-socket'

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
  edgeAuth?: PairedRuntimeConnection['edgeAuth']
  hostCapabilities: readonly string[] | undefined
  send?: typeof sendRemoteRuntimeRequestOnSocket
  timeoutMs?: number
}): Promise<string> {
  if (!args.hostCapabilities?.includes(PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY)) {
    return args.pairingCode
  }
  const deviceToken = randomHexToken()
  const send = args.send ?? sendRemoteRuntimeRequestOnSocket
  try {
    const response = await send(
      { ...pairedRuntimeConnectionFromOffer(args.offer), edgeAuth: args.edgeAuth },
      EXCHANGE_PAIRING_TICKET_METHOD,
      { deviceToken },
      args.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    if (!response.ok) {
      return args.pairingCode
    }
    const exchanged = { ...args.offer, deviceToken }
    // Sign in once now so the host retires the link immediately; a host downgraded before this
    // client's first later use would not know the new token. The host already stored it, so a
    // failure here still leaves the new token working.
    await send(
      { ...pairedRuntimeConnectionFromOffer(exchanged), edgeAuth: args.edgeAuth },
      'status.get',
      undefined,
      args.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ).catch(() => undefined)
    return encodePairingOffer(exchanged)
  } catch {
    return args.pairingCode
  }
}
