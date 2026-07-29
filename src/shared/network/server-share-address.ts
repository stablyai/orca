// Why: shared validator for the "Share this Orca server" custom address. The
// field accepts a bare host, host:port, or a full ws(s):// URL — looser than
// the mobile pairing grammar because the target is a transport endpoint, not
// just an IP. Kept pure so the renderer and any future caller agree.

export type ParseServerShareAddressResult = { ok: true; value: string } | { ok: false }

const HOST_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?'
const HOSTNAME = `${HOST_LABEL}(?:\\.${HOST_LABEL})*`
const IPV4 = '(?:\\d{1,3}\\.){3}\\d{1,3}'
const HOST = `(?:${HOSTNAME}|${IPV4})`
const PORT = '[0-9]{1,5}'

const HOST_OR_HOST_PORT = new RegExp(`^${HOST}(?::${PORT})?$`)

export function parseServerShareAddress(input: string): ParseServerShareAddressResult {
  const trimmed = input.trim()
  if (trimmed === '' || /\s/.test(trimmed)) {
    return { ok: false }
  }

  // Full ws(s):// URL — defer to the URL parser, which validates host/port/path.
  if (/^wss?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return url.hostname !== '' ? { ok: true, value: trimmed } : { ok: false }
    } catch {
      return { ok: false }
    }
  }

  // Bare host or host:port. Reject an out-of-range port early.
  const match = trimmed.match(HOST_OR_HOST_PORT)
  if (!match) {
    return { ok: false }
  }
  const portPart = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : null
  if (portPart !== null && Number(portPart) > 65535) {
    return { ok: false }
  }
  return { ok: true, value: trimmed }
}

// Why: a shared address that resolves to loopback produces a pairing link only
// this computer can dial, so both the picker and the generated link warn on it.
export function isLoopbackShareAddress(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed === '') {
    return false
  }

  let host = trimmed
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname
    } catch {
      return false
    }
  } else if (HOST_OR_HOST_PORT.test(trimmed) && trimmed.includes(':')) {
    host = trimmed.slice(0, trimmed.lastIndexOf(':'))
  }

  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  )
}
