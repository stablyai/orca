import { getConnectionIdForFile } from '@/lib/connection-context'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { getRuntimeGitFileBlame, getRuntimeGitLineBlame } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import type { GitLineBlameResult } from '../../../shared/git-line-blame-types'

/** Why: debounce so scrubbing the cursor doesn't queue a git blame per line. */
export const BLAME_DEBOUNCE_MS = 250

/**
 * How long a file's authorship is trusted.
 *
 * Why time-bounded at all: nothing in the renderer reports the worktree's HEAD,
 * so a commit, amend, rebase, or pull made outside the editor — which agents do
 * constantly here — changes a line's author while the path, contents, and dirty
 * flag all stay put. Rather than show a confidently wrong author for the life of
 * the tab, authorship expires.
 *
 * Why the window belongs to the FILE, not the line: expiry has to be repaired by
 * one whole-file walk. Expiring lines individually would send each newly visited
 * line back to per-line blame, and `-L` walks the whole history anyway — that is
 * the cost this cache exists to avoid.
 */
export const CACHE_TTL_MS = 60_000

// Why a ceiling at all: the cache is module-scoped, so it outlives the component
// that filled it. Oldest-first eviction rather than refusing new entries, so a
// file past the ceiling still caches the lines being read now instead of sending
// every one of them back to a full-history walk.
const MAX_CACHED_LINES = 50_000

// Why a NUL: paths and ids can contain spaces, so a printable separator could
// let two different targets build the same key. Built at runtime rather than
// written as a literal, so no control byte lands in the source — one did once,
// and git then treated this file as binary and hid its diff from review.
const SEPARATOR = String.fromCharCode(0)

export type BlameTarget = {
  worktreeId: string
  /** Absolute path, used to resolve which host owns the file. */
  filePath: string
  /** Path relative to `worktreePath`, which is the repo git actually runs in. */
  relativePath: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  line: number
}

export type BlameAnswer = {
  key: string
  result: GitLineBlameResult | null
  /** When the underlying git read happened, so a consumer can expire what it shows. */
  readAt: number
}

/**
 * Identity of the FILE a blame belongs to — everything in the request key except
 * the line, so one whole-file read can answer every line of it.
 */
export function blameFileKey(target: BlameTarget): string {
  return [
    target.worktreeId,
    target.worktreePath,
    target.relativePath,
    target.runtimeEnvironmentId ?? ''
  ].join(SEPARATOR)
}

/**
 * Identity of a blame request: every field that routes it, not just the visible
 * file and line. Switching runtime owner keeps the same worktree id, path, and
 * line, so a narrower key would let a previous host's answer paint.
 */
export function blameKey(target: BlameTarget): string {
  return [
    target.worktreeId,
    target.worktreePath,
    target.relativePath,
    target.runtimeEnvironmentId ?? '',
    String(target.line)
  ].join(SEPARATOR)
}

// Why module scope: the status-bar segment and the inline annotation both track
// the cursor, and both ship on by default. Per-component queues would spawn one
// `git blame` per surface for the same line — two child processes, two IPC round
// trips, twice over an SSH relay. One pump means the second consumer reads the
// first one's answer.
type CachedBlame = { result: GitLineBlameResult; readAt: number }
const settled = new Map<string, CachedBlame>()

// Whole-file reads, keyed by file. `startedAt` drives expiry so a stale file is
// repaired by a single re-walk; the promise lets a second surface asking
// mid-read await it instead of racing off to per-line blame.
type FileLoad = { promise: Promise<void>; startedAt: number }
const fileLoads = new Map<string, FileLoad>()

const subscribers = new Set<(answer: BlameAnswer) => void>()
let queued: BlameTarget | null = null
let inFlightKey: string | null = null
// Which generation the in-flight request belongs to, so a request suppressed as
// a duplicate is only suppressed by work that is still valid.
let inFlightGeneration = 0
// Bumped whenever the cache is invalidated, so work already in flight can
// neither cache nor publish authorship for a revision the editor has left.
let generation = 0

export function cachedLineBlame(key: string, now = Date.now()): GitLineBlameResult | null {
  const entry = settled.get(key)
  if (!entry) {
    return null
  }
  if (now - entry.readAt > CACHE_TTL_MS) {
    settled.delete(key)
    return null
  }
  return entry.result
}

function cacheBlame(key: string, result: GitLineBlameResult, readAt: number): void {
  if (settled.size >= MAX_CACHED_LINES) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = settled.keys().next().value
    if (oldest !== undefined) {
      settled.delete(oldest)
    }
  }
  settled.set(key, { result, readAt })
}

export function subscribeToLineBlame(listener: (answer: BlameAnswer) => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** Drop cached authorship that an edit or a different file has invalidated. */
export function clearLineBlameCache(): void {
  settled.clear()
  fileLoads.clear()
  generation += 1
}

/**
 * Read authorship for the whole file, once per TTL window.
 *
 * Why not per line: `-L` does not make `git blame` cheaper — git walks the same
 * history and discards everything but the requested line — so a per-line read
 * pays the full cost on every cursor move (measured at ~1.9s per line on a
 * 37k-line file). One walk answers every line for that same price.
 */
function ensureFileBlame(target: BlameTarget, now: number): Promise<void> {
  const fileKey = blameFileKey(target)
  const existing = fileLoads.get(fileKey)
  if (existing && now - existing.startedAt <= CACHE_TTL_MS) {
    return existing.promise
  }
  const entry: FileLoad = { promise: loadFileBlame(target), startedAt: now }
  fileLoads.set(fileKey, entry)
  return entry.promise
}

async function loadFileBlame(target: BlameTarget): Promise<void> {
  const startedGeneration = generation
  const byLine = await getRuntimeGitFileBlame(
    {
      settings: settingsForRuntimeOwner(
        useAppStore.getState().settings,
        target.runtimeEnvironmentId
      ),
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      connectionId: getConnectionIdForFile(target.worktreeId, target.filePath) ?? undefined
    },
    { filePath: target.relativePath }
  ).catch(() => null)
  if (startedGeneration !== generation) {
    // The file or its contents changed while this read was in flight; its
    // authorship describes a revision the editor has already left.
    return
  }
  if (!byLine) {
    // Whole-file blame is unavailable here (older host, oversized file). The
    // entry stays for the TTL window so we don't re-attempt the expensive walk
    // per line — per-line blame takes over for this file.
    return
  }
  const readAt = Date.now()
  for (const [line, result] of Object.entries(byLine)) {
    if (result && !result.isUncommitted) {
      cacheBlame(blameKey({ ...target, line: Number(line) }), result, readAt)
    }
  }
  // Answer the line that triggered the read, so the waiting surface paints
  // without a second round trip.
  const key = blameKey(target)
  publish({ key, result: cachedLineBlame(key), readAt })
}

/**
 * Queue a blame, replacing any target that has not started yet.
 *
 * Latest-wins rather than same-key coalescing: while one blame runs the cursor
 * has usually moved on, and only the newest resting line is still wanted.
 */
export function requestLineBlame(target: BlameTarget): void {
  const now = Date.now()
  const key = blameKey(target)
  const cached = cachedLineBlame(key, now)
  if (cached) {
    publish({ key, result: cached, readAt: now })
    return
  }
  // Why the generation test: both surfaces debounce the same cursor line and ask
  // independently, so a duplicate of work already running should be dropped —
  // but only while that work is still valid. After an invalidation the same key
  // must be allowed to run again, or the file would keep showing the answer the
  // obsolete request is about to deliver.
  if (key === inFlightKey && generation === inFlightGeneration) {
    return
  }
  void ensureFileBlame(target, now).then(() => {
    const fresh = cachedLineBlame(key)
    if (fresh) {
      // Why publish rather than return: this consumer may have asked for a
      // different line than the one that triggered the read, so it still needs
      // its own answer delivered.
      publish({ key, result: fresh, readAt: Date.now() })
      return
    }
    queued = target
    pump()
  })
}

function pump(): void {
  if (inFlightKey !== null) {
    return
  }
  const next = queued
  if (!next) {
    return
  }
  queued = null
  const key = blameKey(next)
  const startedGeneration = generation
  inFlightKey = key
  inFlightGeneration = startedGeneration
  void getRuntimeGitLineBlame(
    {
      settings: settingsForRuntimeOwner(useAppStore.getState().settings, next.runtimeEnvironmentId),
      worktreeId: next.worktreeId,
      worktreePath: next.worktreePath,
      // Why: folder workspaces resolve ownership per file, so asking the
      // workspace would route a child repo's blame at the wrong host.
      connectionId: getConnectionIdForFile(next.worktreeId, next.filePath) ?? undefined
    },
    { filePath: next.relativePath, line: next.line }
  )
    .then((result) => {
      if (startedGeneration !== generation) {
        // Obsolete: neither cache it nor show it.
        return
      }
      const readAt = Date.now()
      // Why: only cache committed authorship. An uncommitted line becomes a real
      // commit the moment the user commits, and a cached "Uncommitted" would
      // outlive that.
      if (result && !result.isUncommitted) {
        cacheBlame(key, result, readAt)
      }
      publish({ key, result, readAt })
    })
    .catch(() => {
      if (startedGeneration === generation) {
        publish({ key, result: null, readAt: Date.now() })
      }
    })
    .finally(() => {
      inFlightKey = null
      pump()
    })
}

function publish(answer: BlameAnswer): void {
  for (const listener of subscribers) {
    listener(answer)
  }
}

/** Reset module state between tests. */
export function resetLineBlameRequestsForTests(): void {
  settled.clear()
  subscribers.clear()
  fileLoads.clear()
  queued = null
  inFlightKey = null
  inFlightGeneration = 0
  generation = 0
}
