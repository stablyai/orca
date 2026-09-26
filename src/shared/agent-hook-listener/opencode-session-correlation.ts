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
   * is the root or beneath it; same-worktree panes tie and the evidence below
   * decides between them.
   */
  directory: string | null
  /**
   * ms epoch of the pane's last prompt activity (renderer keystroke, or a
   * prompt Orca delivered host-side), or null/absent when the pane has had
   * none since Orca registered it. Supplied by the binder so same-directory
   * ties can be broken by who actually submitted the prompt, not by who merely
   * had a client alive.
   */
  lastInputAtMs?: number | null
  /**
   * The stamp `lastInputAtMs` replaced. The row appears once the prompt is
   * submitted and the creator commonly keeps typing, so the submission is often
   * only visible in this older slot.
   */
  previousInputAtMs?: number | null
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

/**
 * How long before a session's creation a pane's last keystroke still counts
 * as evidence that pane submitted the prompt which created it. OpenCode
 * writes the session row when the prompt is submitted, and the Enter that
 * submits it is itself PTY input, so a minute is generous — and keeping it
 * narrow matters, because a pane the human happened to touch just before an
 * Orca-launched agent minted its session (a launch whose prompt arrives as a
 * flag, leaving that pane no input of its own) must not be credited with it.
 */
export const OPENCODE_INPUT_TIEBREAK_WINDOW_MS = 60 * 1000

/**
 * How long before a session's creation a pane's OpenCode client must have
 * started for that start to identify the pane as the creator. Orca-launched
 * agents pass their first prompt on the command line (`--prompt`), so the pane
 * that created the session never writes a keystroke of its own — which is why
 * launch recency is consulted before input recency: a client that booted
 * seconds before the row appeared explains the session's existence, whereas a
 * bystander's keystroke does not. Opening an OpenCode pane is a deliberate,
 * rare act, so this is far higher precision than typing, which is constant.
 *
 * 20s is ~2x the startup Orca already measures for this binary (paste-ready
 * ~4.8s, composer ~10s — see `draftPasteReadyTimeoutMs`), and stays tight
 * enough that a pane merely *opened* this minute while another pane prompted
 * does not read as the launcher.
 */
export const OPENCODE_LAUNCH_TIEBREAK_WINDOW_MS = 20 * 1000

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

/**
 * True when two pane directories name the same place after the normalization
 * session containment uses (macOS /private alias, Windows case and backslash
 * folding, dot segments). Raw equality here would discard a reminted pane's
 * input history whenever only the path's spelling changed, handing the
 * session to a pane with older activity — the opposite of the guard's intent.
 */
export function openCodeDirectoryMatches(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false
  }
  return normalizeDir(left) === normalizeDir(right)
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
 * Outcome of one evidence probe. `abstain` is not the same as `none`: it means
 * a candidate's history was evicted so it cannot be ruled out as the creator,
 * and therefore no other pane may be credited from the other signal either.
 */
type TieBreakOutcome = { kind: 'owner'; paneKey: string } | { kind: 'none' } | { kind: 'abstain' }

const NO_OWNER: TieBreakOutcome = { kind: 'none' }

/**
 * Break a same-directory tie on the pane whose OpenCode client had just
 * started. This is the only signal available when the creator was launched by
 * Orca with `--prompt`, since that prompt rides on the spawn command and the
 * creating pane never writes to its PTY. The freshest qualifying client wins,
 * and two panes booted together tie and are both rejected.
 */
function tieBreakByFreshLaunch(
  evidencing: readonly CorrelatedPane[],
  clients: readonly CorrelatedClient[],
  createdAtMs: number
): TieBreakOutcome {
  let best: CorrelatedPane | null = null
  let bestStart = Number.NEGATIVE_INFINITY
  let tied = false
  for (const pane of evidencing) {
    let newest = Number.NEGATIVE_INFINITY
    for (const client of clients) {
      if (client.paneKey !== pane.paneKey || !clientCouldCreate(client, createdAtMs)) {
        continue
      }
      // Reject here rather than on the pane's newest: clientCouldCreate allows
      // starts up to CREATE_SKEW after the row, so testing only the max would
      // let a later client (an `opencode run` spawned inside the pane) mask an
      // earlier one that really was the launch. A pane holding only
      // post-creation clients still ends at -Infinity and is skipped below.
      if (client.startedAtMs > createdAtMs + 2_000) {
        continue
      }
      if (client.startedAtMs > newest) {
        newest = client.startedAtMs
      }
    }
    if (newest === Number.NEGATIVE_INFINITY) {
      continue
    }
    if (createdAtMs - newest > OPENCODE_LAUNCH_TIEBREAK_WINDOW_MS) {
      continue
    }
    if (newest > bestStart) {
      best = pane
      bestStart = newest
      tied = false
    } else if (newest === bestStart) {
      tied = true
    }
  }
  return best && !tied ? { kind: 'owner', paneKey: best.paneKey } : NO_OWNER
}

/**
 * Break a same-directory tie by which pane submitted the prompt. Creating a
 * session writes to that pane's PTY immediately beforehand — a human keystroke
 * or a prompt Orca delivered — so the candidate with the newest pre-creation
 * activity is the creator. Both of a pane's stamps are consulted, because the
 * creator will usually have typed again after submitting.
 *
 * A pane whose stamps all postdate the row has had its earlier history evicted,
 * so it cannot be ruled out as the creator; crediting anyone else would be the
 * wrong-pane result this exists to prevent, and the round abstains instead — for
 * the launch signal too, which is why `abstain` is distinct from `none`. A pane
 * with no stamps at all is a launch candidate rather than an input one and is
 * simply not considered here.
 */
function tieBreakByRecentInput(
  evidencing: readonly CorrelatedPane[],
  createdAtMs: number
): TieBreakOutcome {
  let best: CorrelatedPane | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  let tied = false
  for (const pane of evidencing) {
    const stamps = [pane.lastInputAtMs, pane.previousInputAtMs].filter(
      (value): value is number => typeof value === 'number' && !Number.isNaN(value)
    )
    if (stamps.length === 0) {
      continue
    }
    const preCreation = stamps.filter((value) => value <= createdAtMs)
    if (preCreation.length === 0) {
      if (stamps.length >= 2) {
        // Every stamp we hold postdates the row, and two slots means at least
        // two writes since. An earlier submission may have been evicted —
        // unknowable, and not another pane's to claim.
        return { kind: 'abstain' }
      }
      // A single post-creation write cannot have created the row: submitting is
      // itself a write, and it would be the stamp we hold.
      continue
    }
    const activity = Math.max(...preCreation)
    if (createdAtMs - activity > OPENCODE_INPUT_TIEBREAK_WINDOW_MS) {
      continue
    }
    if (activity > bestAt) {
      best = pane
      bestAt = activity
      tied = false
    } else if (activity === bestAt) {
      tied = true
    }
  }
  return best && !tied ? { kind: 'owner', paneKey: best.paneKey } : NO_OWNER
}

/**
 * Decide owners for sessions the registry has not bound yet. Child sessions
 * inherit their root's owner (they roll up to the same pane); argv hits bind
 * immediately; otherwise exactly one pane must have both the directory and a
 * client that brackets the creation. When several panes qualify — the normal
 * case for split panes or sibling folder workspaces, which share a directory —
 * two signals are computed: the pane whose client had just booted (which covers
 * Orca-launched agents, whose prompt rides on the spawn command and leaves their
 * pane no keystroke) and the pane whose PTY received input just before the
 * session appeared. Each must yield an unambiguous in-window leader, and they
 * must agree, before anything is bound. Anything still undecided stays unbound
 * rather than guessed: a wrong owner shows the wrong pane spinning, which is the
 * bug this resolves, not a milder version of it.
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
      // Launch recency covers an Orca-launched agent, which carries its first
      // prompt on the spawn command and so never writes a keystroke; input
      // recency covers a prompt typed or dispatched in a shared directory.
      const launch = tieBreakByFreshLaunch(evidencing, clients, session.createdAtMs)
      const input = tieBreakByRecentInput(evidencing, session.createdAtMs)
      // An evicted candidate cannot be ruled out as the creator, so no other
      // pane may be credited — not even by a launch that would otherwise stand
      // uncontradicted.
      if (input.kind === 'abstain') {
        continue
      }
      // Why disagreement abstains: a pane that just booted and a pane that was
      // just written to explain this row equally well, and no evidence tells a
      // launched creator apart from an innocent pane someone happened to open
      // nearby. Picking a side would risk the wrong-pane result this file
      // exists to prevent, so only agreement is acted on.
      const disagrees =
        launch.kind === 'owner' && input.kind === 'owner' && launch.paneKey !== input.paneKey
      const owner =
        launch.kind === 'owner' ? launch.paneKey : input.kind === 'owner' ? input.paneKey : null
      if (owner && !disagrees) {
        claim(session.id, owner, 'creation-correlation')
      }
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
