// Shared so the main process (open-url / argv) and the renderer (in-terminal OSC 8 clicks)
// classify `orca://` links with identical rules.
//
// Emitting a focus link into a terminal requires a real OSC 8 hyperlink: a bare plain-text
// `orca://focus/<handle>` will not linkify, because WebLinksAddon only autodetects http(s).

export const ORCA_URL_SCHEME = 'orca'

/** `orca://worktree/<id>` is deferred: worktree ids embed `repoId::path` and need encoding. */
export type OrcaDeepLink = { kind: 'focus'; handle: string }

// Runtime-issued handles are `term_<uuid>`; anything else is rejected so a malformed or
// hostile link can never reach the focus action.
const TERMINAL_HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/

/** Returns null for unrelated `orca://` URLs (skill share, pair) so callers ignore them. */
export function parseOrcaDeepLink(url: string): OrcaDeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ORCA_URL_SCHEME}:` || parsed.hostname !== 'focus') {
    return null
  }
  // Why: the handle rides in the path, not the host, because URL parsing lowercases
  // hostnames and the runtime matches handles case-sensitively.
  let handle: string
  try {
    handle = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  return TERMINAL_HANDLE_PATTERN.test(handle) ? { kind: 'focus', handle } : null
}

export function orcaDeepLinkFromArguments(argv: readonly string[] | undefined): string | null {
  if (!argv) {
    return null
  }
  for (const value of argv) {
    if (typeof value === 'string' && parseOrcaDeepLink(value)) {
      return value
    }
  }
  return null
}
