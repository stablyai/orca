/**
 * Pure session→pane correlation for the shared OpenCode server (#21359).
 *
 * The server stamps every post with its own frozen pane, so the binder must
 * decide ownership from client-side evidence: which panes sit in the
 * session's directory, and which of those panes runs an OpenCode client that
 * could have created it. No platform APIs here — the main-process binder
 * supplies sessions (SQLite), panes (PTY registry + CWD) and clients
 * (argv-aware process sweep); this module only decides.
 */

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
  /**
   * Worktree root backing the pane (from the PTY registry), or null when
   * unknown. A session belongs to a pane's candidate set when its directory
   * is the root or beneath it; same-worktree panes tie and the client sweep
   * breaks the tie.
   */
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

/**
 * macOS symlinks /tmp, /var and /etc into /private; opencode records
 * whichever spelling the process saw, so fold the alias to the real root
 * before comparing. Narrow on purpose: a blanket `/private` strip would merge
 * genuinely distinct POSIX roots (`/private/repo` vs `/repo`).
 */
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

/**
 * Comparison key for session/pane directories. NFC + Windows-only backslash
 * folding and case folding come from the shared helper (a backslash stays a
 * literal filename character on POSIX); dot segments resolve lexically.
 */
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
  // Why lifetime-overlap instead of a start window: a TUI opened days ago
  // creates today's session from the same process. Started-before plus
  // seen-alive-after brackets the creation; a start window alone would miss
  // every long-lived client.
  return (
    client.startedAtMs <= createdAtMs + OPENCODE_CREATE_SKEW_MS &&
    client.lastSeenAliveMs >= createdAtMs
  )
}

/**
 * Decide owners for sessions the registry has not bound yet. Child sessions
 * inherit their root's owner (they roll up to the same pane); argv hits bind
 * immediately; otherwise exactly one pane must have both the directory and a
 * client that brackets the creation. Anything else stays unbound — today's
 * behavior — rather than guessing.
 */
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

  // Why argv first: a command line names its session outright, so it outranks
  // every heuristic even when the directory is crowded.
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
    // Why the basis split: a lone containing pane needs no client evidence
    // to be unambiguous; a shared worktree always resolves through it.
    claim(
      session.id,
      only.paneKey,
      candidates.length === 1 ? 'single-pane-directory' : 'creation-correlation'
    )
  }

  return results
}
