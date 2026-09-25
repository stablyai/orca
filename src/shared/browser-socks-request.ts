export type RemoteBrowserNetworkTarget = { host: string; port: number }
type SocksRequest = { consumed: number; command: number; target: RemoteBrowserNetworkTarget }
const SOCKS_VERSION = 5
const SOCKS_IPV4 = 1
const SOCKS_DOMAIN = 3
const SOCKS_IPV6 = 4

export function parseSocksRequest(buffer: Uint8Array): SocksRequest | null | undefined {
  if (buffer.byteLength < 4) {
    return undefined
  }
  if (buffer[0] !== SOCKS_VERSION || buffer[2] !== 0) {
    return null
  }
  const addressType = buffer[3]
  let host: string
  let addressEnd: number
  if (addressType === SOCKS_IPV4) {
    if (buffer.byteLength < 10) {
      return undefined
    }
    host = Array.from(buffer.subarray(4, 8)).join('.')
    addressEnd = 8
  } else if (addressType === SOCKS_DOMAIN) {
    if (buffer.byteLength < 5) {
      return undefined
    }
    const length = buffer[4]!
    addressEnd = 5 + length
    if (length === 0 || buffer.byteLength < addressEnd + 2) {
      return length === 0 ? null : undefined
    }
    try {
      host = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(5, addressEnd))
    } catch {
      return null
    }
  } else if (addressType === SOCKS_IPV6) {
    if (buffer.byteLength < 22) {
      return undefined
    }
    host = formatIpv6(buffer.subarray(4, 20))
    addressEnd = 20
  } else {
    return null
  }
  if (!host || buffer.byteLength < addressEnd + 2) {
    return undefined
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const port = view.getUint16(addressEnd, false)
  if (port === 0) {
    return null
  }
  return {
    consumed: addressEnd + 2,
    command: buffer[1]!,
    target: { host, port }
  }
}

export function normalizeListenerWildcard(
  target: RemoteBrowserNetworkTarget
): RemoteBrowserNetworkTarget {
  if (target.host === '0.0.0.0') {
    return { ...target, host: '127.0.0.1' }
  }
  if (target.host === '::' || target.host === '0:0:0:0:0:0:0:0') {
    return { ...target, host: '::1' }
  }
  return target
}

function formatIpv6(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: 8 }, (_, index) =>
    view.getUint16(index * 2, false).toString(16)
  ).join(':')
}
