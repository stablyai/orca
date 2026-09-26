import { parsePairingCode, type PairingOffer } from './pairing'
import {
  classifyRemotePairingHostname,
  getEmbeddedIPv4Address,
  type RemotePairingEndpointKind
} from './remote-pairing-endpoint'

export type ParsedHostAccessLink = {
  pairing: PairingOffer
  displayEndpoint: string
  endpointKind: RemotePairingEndpointKind
}

export type HostAccessLinkErrorKind =
  | 'invalid-input'
  | 'mobile-only'
  | 'invalid-destination'
  | 'unsupported-destination'
  | 'non-connectable-destination'

export type ParseHostAccessLinkResult =
  | { ok: true; value: ParsedHostAccessLink }
  | { ok: false; kind: HostAccessLinkErrorKind; message: string }

export function parseHostAccessLink(input: string): ParseHostAccessLinkResult {
  const pairing = parsePairingCode(input)
  if (!pairing) {
    return {
      ok: false,
      kind: 'invalid-input',
      message: 'Enter an Orca access link or bare pairing code.'
    }
  }
  if (pairing.scope === 'mobile') {
    return {
      ok: false,
      kind: 'mobile-only',
      message: 'This link grants mobile-only access. Generate a link for another Orca client.'
    }
  }
  let endpoint: URL
  try {
    endpoint = new URL(pairing.endpoint)
  } catch {
    return {
      ok: false,
      kind: 'invalid-destination',
      message: 'This access link contains an invalid destination.'
    }
  }
  if (
    (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
    !endpoint.hostname ||
    endpoint.hash !== ''
  ) {
    return {
      ok: false,
      kind: 'unsupported-destination',
      message: 'This access link contains an unsupported destination.'
    }
  }
  const normalizedHostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalizedHostname === '0.0.0.0' ||
    normalizedHostname === '::' ||
    getEmbeddedIPv4Address(normalizedHostname) === '0.0.0.0' ||
    endpoint.port === '0'
  ) {
    return {
      ok: false,
      kind: 'non-connectable-destination',
      message: 'This access link contains a non-connectable destination.'
    }
  }
  return {
    ok: true,
    value: {
      pairing,
      displayEndpoint: endpoint.host,
      endpointKind: classifyRemotePairingHostname(endpoint.hostname)
    }
  }
}
