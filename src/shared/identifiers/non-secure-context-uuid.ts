/** Use getRandomValues when HTTP LAN/Tailscale browsers hide randomUUID; direct module-scope calls would white-screen Remote Web.
 * Node/Electron and secure contexts use guarded randomUUID normally. */
export function createNonSecureContextUuid(): string {
  const cryptoApi = globalThis.crypto
  // oxlint-disable-next-line no-restricted-properties -- the sanctioned escape hatch: the one guarded call every other site routes through.
  if (typeof cryptoApi?.randomUUID === 'function') {
    // oxlint-disable-next-line no-restricted-properties -- the sanctioned escape hatch (see above).
    return cryptoApi.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    // Why: these are local UI and correlation ids, not auth credentials.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytesToUuid(bytes)
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
