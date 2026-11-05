/** Correlate frozen shared-server stamps from client evidence (#21359). Main supplies SQLite sessions, PTY directories and argv-aware process sweeps; this module stays platform-API-free. */

/** One session row as the binder sees it. */
export type CorrelatedSession = {
  id: string
  directory: string
  /** ms epoch from the session store. */
  createdAtMs: number
  parentId: string | null
}

/** One pane as the binder sees it. */
export type CorrelatedPane = {
  paneKey: string
  /** Candidate worktree root; exact/descendant directories qualify, and client evidence resolves ownership. */
  directory: string | null
}

/** One live client process as the binder sees it. */
export type CorrelatedClient = {
  /** Pane whose subtree holds this client. */
  paneKey: string
  /** ms epoch the client process started. */
  startedAtMs: number
  /** ms epoch the client was last observed alive. */
  lastSeenAliveMs: number
  /** Full argv; a `--session <id>` hit binds deterministically. */
  argv: readonly string[]
}

/** One decided session owner for this round. */
export type SessionOwnership = {
  sessionId: string
  paneKey: string
  basis: 'argv' | 'creation-correlation' | 'single-pane-directory'
}

/** Allow for stamp skew between the process table and the session store. */
export const OPENCODE_CREATE_SKEW_MS = 2 * 60 * 1000

import { normalizeRuntimePathForComparison } from '../cross-platform-path'

/** Fold only macOS /tmp, /var and /etc aliases; stripping every /private prefix would merge distinct roots. */
function foldMacOsPrivateAlias(directory: string): string {
  for (const name of ['tmp', 'var', 'etc']) {
    if (directory === `/${name}`) {
      return `/private/${name}`
    }
    if (directory.startsWith(`/${name}/`)) {
      return `/private/${directory.slice(1)}`
    }
  }
  return directory
}

/** Lexically resolve `.` and `..` so prefix containment cannot be fooled by dot segments. */
function resolveDotSegments(normalized: string): string {
  const isAbsolute = normalized.startsWith('/')
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') {
        parts.pop()
        continue
      }
      if (!isAbsolute) {
        parts.push(part)
      }
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (isAbsolute) {
    return `/${joined}`
  }
  return joined === '' ? '.' : joined
}

/** Normalize NFC, Windows separators/case and lexical dot segments; POSIX backslashes stay literal. */
function normalizeDir(directory: string): string {
  return resolveDotSegments(
    normalizeRuntimePathForComparison(foldMacOsPrivateAlias(directory.trim()))
  )
}

/** `--session <id>`, `-s <id>`, `--session=<id>` or a trailing attach target. */
export function sessionIdFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--session' || arg === '-s') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        return next
      }
    } else if (arg.startsWith('--session=')) {
      const value = arg.slice('--session='.length)
      if (value) {
        return value
      }
    }
  }
  return null
}

function clientCouldCreate(client: CorrelatedClient, createdAtMs: number): boolean {
  // Long-lived clients create later sessions; bracket creation by start/last-alive times, not a narrow start window.
  return (
    client.startedAtMs <= createdAtMs + OPENCODE_CREATE_SKEW_MS &&
    client.lastSeenAliveMs >= createdAtMs
  )
}

/** Explicit argv binds first, children inherit known owners, otherwise require exactly one directory candidate with overlapping client lifetime. Leave ambiguity unbound. */
export function correlateOpenCodeSessionOwners(args: {
  sessions: readonly CorrelatedSession[]
  panes: readonly CorrelatedPane[]
  clients: readonly CorrelatedClient[]
  /** Owners already known (registry + earlier binds this round). */
  knownOwners: ReadonlyMap<string, string>
}): SessionOwnership[] {
  const { sessions, panes, clients, knownOwners } = args
  const owners = new Map(knownOwners)
  const results: SessionOwnership[] = []

  /** Record one ownership decision, visible to later sessions in this round. */
  const claim = (sessionId: string, paneKey: string, basis: SessionOwnership['basis']): void => {
    owners.set(sessionId, paneKey)
    results.push({ sessionId, paneKey, basis })
  }

  // Explicit session argv outranks directory/timing heuristics.
  for (const client of clients) {
    const named = sessionIdFromArgv(client.argv)
    if (named && !owners.has(named)) {
      claim(named, client.paneKey, 'argv')
    }
  }

  const panesByDirectory = new Map<string, CorrelatedPane[]>()
  for (const pane of panes) {
    if (!pane.directory) {
      continue
    }
    const key = normalizeDir(pane.directory)
    const list = panesByDirectory.get(key)
    if (list) {
      list.push(pane)
    } else {
      panesByDirectory.set(key, [pane])
    }
  }

  /** Panes whose worktree root contains this directory (exact or beneath). */
  function containingPanes(directory: string): CorrelatedPane[] {
    const target = normalizeDir(directory)
    const found: CorrelatedPane[] = []
    for (const [root, list] of panesByDirectory) {
      if (target === root || target.startsWith(`${root}/`)) {
        found.push(...list)
      }
    }
    return found
  }

  /** Walk the parent chain for an already-known root owner. */
  const rootOwner = (session: CorrelatedSession): string | undefined => {
    let current: CorrelatedSession | undefined = session
    const seen = new Set<string>()
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id)
      const owner = owners.get(current.parentId)
      if (owner) {
        return owner
      }
      current = sessions.find((s) => s.id === current?.parentId)
    }
    return current && current !== session ? owners.get(current.id) : undefined
  }

  for (const session of sessions) {
    if (owners.has(session.id)) {
      continue
    }
    const inherited = session.parentId
      ? (rootOwner(session) ?? owners.get(session.parentId))
      : undefined
    if (inherited) {
      claim(session.id, inherited, 'creation-correlation')
      continue
    }
    const candidates = containingPanes(session.directory)
    if (candidates.length === 0) {
      continue
    }
    const evidencing = candidates.filter((pane) =>
      clients.some(
        (client) =>
          client.paneKey === pane.paneKey && clientCouldCreate(client, session.createdAtMs)
      )
    )
    const [only] = evidencing
    if (evidencing.length !== 1 || !only) {
      continue
    }
    // The basis records whether directory candidates were unique; both paths still require one evidencing client pane.
    claim(
      session.id,
      only.paneKey,
      candidates.length === 1 ? 'single-pane-directory' : 'creation-correlation'
    )
  }

  return results
}
