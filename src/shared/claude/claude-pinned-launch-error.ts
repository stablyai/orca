const CODES = ['account-missing', 'provenance', 'unsupported-host'] as const

export type ClaudePinnedLaunchErrorCode = (typeof CODES)[number]

const MARKER_RE = /\[claude_pinned:([a-z-]+)\]/

export function claudePinnedLaunchError(code: ClaudePinnedLaunchErrorCode, message: string): Error {
  // Why: errors cross IPC as strings; the trailing token lets the renderer localize without parsing prose.
  return new Error(`${message} [claude_pinned:${code}]`)
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
