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

const MARKER_RE = /\[claude_pinned:([a-z-]+)\]/

export function claudePinnedLaunchError(code: ClaudePinnedLaunchErrorCode, message: string): Error {
  // Why: errors cross IPC as strings; the trailing token lets the renderer localize without parsing prose.
  return new Error(`${message} [claude_pinned:${code}]`)
}

export function readClaudePinnedLaunchErrorCode(text: string): ClaudePinnedLaunchErrorCode | null {
  const match = MARKER_RE.exec(text)
  const code = match?.[1]
  return CODES.find((candidate) => candidate === code) ?? null
}
