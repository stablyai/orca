const CODES = [
  'host-sessions',
  'host-mutation',
  'usage-fetch',
  'account-missing',
  'became-active',
  'credentials',
  'provenance'
] as const

export type ClaudePinnedLaunchErrorCode = (typeof CODES)[number]

export type ClaudePinnedLaunchErrorDetails = { email?: string; terminalCount?: number }

const MARKER_RE = /\[claude_pinned:([a-z-]+)((?: [a-z]+=[^\s\]]*)*)\]/
const MAX_EMAIL_LENGTH = 320

function encodeDetails(details: ClaudePinnedLaunchErrorDetails | undefined): string {
  if (!details) {
    return ''
  }
  const email = details.email ? ` email=${encodeURIComponent(details.email)}` : ''
  const terminals = details.terminalCount === undefined ? '' : ` terminals=${details.terminalCount}`
  return `${email}${terminals}`
}

export function claudePinnedLaunchError(
  code: ClaudePinnedLaunchErrorCode,
  message: string,
  details?: ClaudePinnedLaunchErrorDetails
): Error {
  // Why: errors cross IPC as strings; the trailing token lets the renderer localize without parsing prose.
  return new Error(`${message} [claude_pinned:${code}${encodeDetails(details)}]`)
}

const DISPLAY_MARKER_RE = new RegExp(`\\s?${MARKER_RE.source}`, 'g')

/** CLI and mobile print host errors verbatim; the marker is only for the renderer's parser. */
export function stripClaudePinnedLaunchMarker(text: string): string {
  return text.replace(DISPLAY_MARKER_RE, '')
}

export function readClaudePinnedLaunchErrorCode(text: string): ClaudePinnedLaunchErrorCode | null {
  const match = MARKER_RE.exec(text)
  const code = match?.[1]
  return CODES.find((candidate) => candidate === code) ?? null
}

function decodeEmail(raw: string): string | undefined {
  try {
    const email = decodeURIComponent(raw)
    // Why: the marker is untrusted text by the time it reaches the renderer; keep it one short line.
    const hasControlChar = [...email].some((char) => char.charCodeAt(0) < 0x20)
    return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && !hasControlChar
      ? email
      : undefined
  } catch {
    return undefined
  }
}

export function readClaudePinnedLaunchErrorDetails(text: string): ClaudePinnedLaunchErrorDetails {
  const details: ClaudePinnedLaunchErrorDetails = {}
  for (const pair of (MARKER_RE.exec(text)?.[2] ?? '').trim().split(' ')) {
    const [key, value = ''] = pair.split('=')
    if (key === 'email') {
      const email = decodeEmail(value)
      if (email) {
        details.email = email
      }
    } else if (key === 'terminals' && /^\d{1,4}$/.test(value)) {
      details.terminalCount = Number(value)
    }
  }
  return details
}
