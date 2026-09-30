import type { IncomingHttpHeaders } from 'node:http'
import { ORCA_HOOK_EXECUTOR_CODEX_SHARED_DAEMON } from '../agent-hook-types'
import { mergeAgentHookRequestHeaders } from './hook-envelope'
import { parsePaneKey } from '../stable-pane-id'
import { splitWorktreeIdForFilesystem } from '../worktree/id'
import { parseWslUncPath } from '../wsl-paths'
import { normalizeAgentSessionDirectory } from './opencode-session-correlation'
import { parseAgentHookJson } from './request-body'

/**
 * Codex >= 0.157 runs every TUI's hooks inside one shared app-server daemon
 * per CODEX_HOME, so the ORCA_* stamp on those posts is the env of whichever
 * pane happened to start the daemon, not of the session that fired the hook.
 * The managed script marks such posts; this decides who owns them from the
 * session's own cwd, before anything downstream reads the stamp.
 */

/** A live local pane that could own a daemon-run Codex session. */
export type CodexDaemonHookPane = {
  /** Null until the renderer re-registers a daemon-hosted PTY after an Orca restart. */
  paneKey: string | null
  worktreeId: string | null
  /** A live Codex client process sits in this pane's process tree (from a host sweep). */
  runsCodexClient: boolean
}

export type CodexDaemonHookAttribution =
  | { kind: 'keep' }
  | { kind: 'rebind'; paneKey: string; worktreeId: string }
  | { kind: 'drop' }

function worktreeRoot(worktreeId: string | null | undefined): string | null {
  if (!worktreeId) {
    return null
  }
  const path = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (!path) {
    return null
  }
  // Why: a WSL pane's worktree is spelled as a UNC path, but Codex inside WSL reports a Linux cwd.
  return normalizeAgentSessionDirectory(parseWslUncPath(path)?.linuxPath ?? path)
}

function containsDirectory(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
}

type CodexClientPane = { paneKey: string; worktreeId: string | null }

function ownedBy(pane: CodexClientPane, stampedPaneKey: string): CodexDaemonHookAttribution {
  if (pane.paneKey === stampedPaneKey) {
    return { kind: 'keep' }
  }
  return pane.worktreeId
    ? { kind: 'rebind', paneKey: pane.paneKey, worktreeId: pane.worktreeId }
    : { kind: 'drop' }
}

/**
 * Owner of one daemon-run Codex post. Only panes with a live Codex client are
 * rebind targets, so a shell or dev-server split never inherits a session.
 * In order: the Codex pane of the session's deepest worktree; the stamp when
 * its worktree holds the cwd; the only Codex pane on the host; a drop when
 * the cwd belongs to a worktree (or one of several Codex panes) that cannot
 * be pinned down; otherwise the stamp. `panes` is null where no pane
 * inventory exists (the SSH relay), which can only keep or drop.
 */
export function attributeCodexDaemonHook(args: {
  cwd: string | undefined
  stampedPaneKey: string
  stampedWorktreeId: string | undefined
  panes: readonly CodexDaemonHookPane[] | null
}): CodexDaemonHookAttribution {
  const cwd = args.cwd?.trim()
  if (!cwd) {
    // Why: nothing to judge the stamp against; keep today's attribution rather than blank a pane.
    return { kind: 'keep' }
  }
  const target = normalizeAgentSessionDirectory(cwd)
  const stampedRoot = worktreeRoot(args.stampedWorktreeId)
  // Why keep an unreadable stamp: without a worktree path there is no evidence against it.
  const stampHoldsCwd = stampedRoot === null || containsDirectory(stampedRoot, target)
  if (args.panes === null) {
    return stampHoldsCwd ? { kind: 'keep' } : { kind: 'drop' }
  }

  const codexPanes = new Map<string, CodexClientPane>()
  let cwdInAnyPaneWorktree = false
  let deepest = -1
  let candidates: CodexClientPane[] = []
  for (const pane of args.panes) {
    const root = worktreeRoot(pane.worktreeId)
    const holdsCwd = root !== null && containsDirectory(root, target)
    cwdInAnyPaneWorktree ||= holdsCwd
    if (!pane.paneKey || !pane.runsCodexClient || codexPanes.has(pane.paneKey)) {
      continue
    }
    const codexPane = { paneKey: pane.paneKey, worktreeId: pane.worktreeId }
    codexPanes.set(pane.paneKey, codexPane)
    if (root === null || !holdsCwd) {
      continue
    }
    // Why deepest: a linked worktree nested inside the main checkout owns its own sessions.
    if (root.length > deepest) {
      deepest = root.length
      candidates = []
    }
    if (root.length === deepest) {
      candidates.push(codexPane)
    }
  }

  if (candidates.some((candidate) => candidate.paneKey === args.stampedPaneKey)) {
    return { kind: 'keep' }
  }
  const [onlyCandidate, ...otherCandidates] = candidates
  if (onlyCandidate) {
    // Why drop on a tie: several Codex panes share the worktree and none is provably the owner.
    return otherCandidates.length === 0
      ? ownedBy(onlyCandidate, args.stampedPaneKey)
      : { kind: 'drop' }
  }
  if (stampHoldsCwd) {
    return { kind: 'keep' }
  }
  const [onlyCodexPane, ...otherCodexPanes] = codexPanes.values()
  if (onlyCodexPane && otherCodexPanes.length === 0) {
    // Why: with one Codex TUI on the host, every daemon post is its own, wherever it cd'd to.
    return ownedBy(onlyCodexPane, args.stampedPaneKey)
  }
  if (cwdInAnyPaneWorktree || codexPanes.size > 1) {
    // Why drop: the stamp is only the daemon starter; keeping it would file a session from
    // another worktree (or another Codex pane) on the starter's row, which is the original bug.
    return { kind: 'drop' }
  }
  // Why keep: no worktree claims the cwd and no rival Codex pane was seen; this is the
  // single-TUI `codex -C <dir>` case or a sweep blind to the client (a WSL pane's Linux tree).
  return { kind: 'keep' }
}

/** True for a body the managed Codex script marked as run by the shared daemon. */
export function isCodexSharedDaemonHookBody(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    Reflect.get(body, 'executor') === ORCA_HOOK_EXECUTOR_CODEX_SHARED_DAEMON
  )
}

function readPayloadCwd(payload: unknown): string | undefined {
  let record: unknown = payload
  if (typeof payload === 'string') {
    try {
      record = parseAgentHookJson(payload)
    } catch {
      return undefined
    }
  }
  if (typeof record !== 'object' || record === null) {
    return undefined
  }
  const cwd: unknown = Reflect.get(record, 'cwd')
  return typeof cwd === 'string' ? cwd : undefined
}

/**
 * Rewrite a hook body's pane stamp when the managed Codex script reported
 * that the shared daemon ran it. Any other body passes through untouched. A
 * dropped post keeps its payload but loses its pane key, so the envelope
 * parser rejects it instead of filing it under the daemon starter's pane.
 */
export function attributeCodexSharedDaemonHookBody(
  body: unknown,
  panes: readonly CodexDaemonHookPane[] | null,
  lookupLaunchToken: (paneKey: string) => string | undefined = () => undefined
): unknown {
  if (typeof body !== 'object' || body === null) {
    return body
  }
  const record: Record<string, unknown> = { ...body }
  if (record.executor !== ORCA_HOOK_EXECUTOR_CODEX_SHARED_DAEMON) {
    return body
  }
  const stampedPaneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const verdict = attributeCodexDaemonHook({
    cwd: readPayloadCwd(record.payload),
    stampedPaneKey,
    stampedWorktreeId: typeof record.worktreeId === 'string' ? record.worktreeId : undefined,
    panes
  })
  if (verdict.kind === 'keep') {
    return body
  }
  if (verdict.kind === 'drop') {
    return { ...record, paneKey: '' }
  }
  return {
    ...record,
    paneKey: verdict.paneKey,
    tabId: parsePaneKey(verdict.paneKey)?.tabId,
    worktreeId: verdict.worktreeId,
    // Why: the stamped token is the daemon starter's; carrying it would fence the real pane.
    launchToken: lookupLaunchToken(verdict.paneKey)
  }
}

/** Relay ingest: with no pane inventory, a daemon post is kept or dropped by its stamped worktree. */
export function mergeRelayAgentHookRequest(body: unknown, headers: IncomingHttpHeaders): unknown {
  return attributeCodexSharedDaemonHookBody(mergeAgentHookRequestHeaders(body, headers), null)
}
