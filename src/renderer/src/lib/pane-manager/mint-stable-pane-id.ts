import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

// Why: Electron/test runtimes can lack crypto.randomUUID. The fallback still
// produces a UUID-shaped v4 id so pane-key validation remains deterministic.
export function mintStablePaneId(): TerminalLeafId {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID() as TerminalLeafId
  }
  const bytes = new Uint8Array(16)
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}` as TerminalLeafId
}
