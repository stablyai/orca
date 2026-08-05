import { createBrowserUuid } from '@/lib/browser-uuid'
import { toWorktreeRelativePath } from '@/lib/terminal-links'

// Why: terminal hover linkify fans out shell:pathExists IPC per candidate
// (#11975). A worktree file listing (same source Quick Open uses) is positive
// evidence only — hit → exists with zero IPC; miss → fall through to stat.

export type TerminalWorktreePathIndexOwnerKey = string

type WorktreePathIndexEntry = {
  relativePaths: Set<string>
  loadedAt: number
  loadPromise: Promise<void> | null
  activeRequestToken: string | null
  cancelLoad: ((requestToken: string) => void) | null
  listRelativePaths: ((requestToken: string) => Promise<readonly string[]>) | null
  // Why: multiple terminal tabs share one listing; only cancel when last consumer leaves.
  leaseCount: number
}

const indexesByKey = new Map<string, WorktreePathIndexEntry>()

const STALE_MS = 5 * 60 * 1000
const MAX_INDEX_ENTRIES = 32

function indexKey(
  worktreeId: string,
  worktreePath: string,
  ownerKey: TerminalWorktreePathIndexOwnerKey
): string {
  return `${worktreeId}\0${worktreePath}\0${ownerKey}`
}

// Why: listFiles returns mixed separators on Windows; comparison keys use '/'.
export function normalizeWorktreeRelativePathKey(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function terminalWorktreePathIndexOwnerKey(args: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}): TerminalWorktreePathIndexOwnerKey {
  const runtimeId = args.runtimeEnvironmentId?.trim()
  if (runtimeId) {
    return `runtime:${runtimeId}`
  }
  const connectionId = args.connectionId?.trim()
  if (connectionId) {
    return `ssh:${connectionId}`
  }
  return 'local'
}

function isFresh(entry: WorktreePathIndexEntry): boolean {
  return entry.loadedAt > 0 && Date.now() - entry.loadedAt < STALE_MS
}

function startIndexLoad(entry: WorktreePathIndexEntry): void {
  if (entry.loadPromise || !entry.listRelativePaths) {
    return
  }
  const requestToken = createBrowserUuid()
  entry.activeRequestToken = requestToken
  const listRelativePaths = entry.listRelativePaths
  const loadPromise = listRelativePaths(requestToken)
    .then((paths) => {
      if (entry.activeRequestToken !== requestToken) {
        return
      }
      const next = new Set<string>()
      for (const path of paths) {
        if (typeof path === 'string' && path.length > 0) {
          next.add(normalizeWorktreeRelativePathKey(path))
        }
      }
      entry.relativePaths = next
      entry.loadedAt = Date.now()
    })
    .catch(() => {
      // Why: listing is best-effort acceleration; hover still uses pathExists.
    })
    .finally(() => {
      // Why: only the active request may clear in-flight state; a cancelled
      // request finishing later must not wipe a newer loadPromise (#11975).
      if (entry.activeRequestToken === requestToken) {
        entry.activeRequestToken = null
        entry.loadPromise = null
      }
    })
  entry.loadPromise = loadPromise
}

export function lookupWorktreeListedPathExists(
  worktreeId: string,
  worktreePath: string,
  absolutePath: string,
  ownerKey: TerminalWorktreePathIndexOwnerKey = 'local'
): true | undefined {
  const entry = indexesByKey.get(indexKey(worktreeId, worktreePath, ownerKey))
  // Why: stale positive hits must not bypass pathExists forever (#11975 review).
  // With an active lease, kick a background reload so multi-minute sessions
  // regain the hot path without waiting for remount.
  if (!entry) {
    return undefined
  }
  if (!isFresh(entry)) {
    if (entry.leaseCount > 0) {
      startIndexLoad(entry)
    }
    return undefined
  }
  const relative = toWorktreeRelativePath(absolutePath, worktreePath)
  if (relative === null || relative === '') {
    return undefined
  }
  if (entry.relativePaths.has(normalizeWorktreeRelativePathKey(relative))) {
    return true
  }
  return undefined
}

function evictOldestIdleIndexesIfNeeded(): void {
  while (indexesByKey.size > MAX_INDEX_ENTRIES) {
    let victimKey: string | undefined
    for (const [key, entry] of indexesByKey) {
      if (entry.leaseCount === 0 && !entry.loadPromise) {
        victimKey = key
        break
      }
    }
    if (victimKey === undefined) {
      break
    }
    indexesByKey.delete(victimKey)
  }
}

export function primeTerminalWorktreePathIndex({
  worktreeId,
  worktreePath,
  ownerKey,
  listRelativePaths,
  cancelLoad
}: {
  worktreeId: string
  worktreePath: string
  ownerKey: TerminalWorktreePathIndexOwnerKey
  listRelativePaths: (requestToken: string) => Promise<readonly string[]>
  cancelLoad?: (requestToken: string) => void
}): void {
  if (!worktreeId || !worktreePath) {
    return
  }
  const key = indexKey(worktreeId, worktreePath, ownerKey)
  let entry = indexesByKey.get(key)
  if (!entry) {
    entry = {
      relativePaths: new Set(),
      loadedAt: 0,
      loadPromise: null,
      activeRequestToken: null,
      cancelLoad: null,
      listRelativePaths: null,
      leaseCount: 0
    }
    indexesByKey.set(key, entry)
  }
  // Why: lease before eviction so a brand-new entry is never chosen as idle victim.
  entry.leaseCount += 1
  entry.listRelativePaths = listRelativePaths
  entry.cancelLoad = cancelLoad ?? null
  evictOldestIdleIndexesIfNeeded()

  if (entry.loadPromise) {
    return
  }
  if (isFresh(entry)) {
    return
  }

  startIndexLoad(entry)
}

export function releaseTerminalWorktreePathIndexLease(
  worktreeId: string,
  worktreePath: string,
  ownerKey: TerminalWorktreePathIndexOwnerKey
): void {
  const entry = indexesByKey.get(indexKey(worktreeId, worktreePath, ownerKey))
  if (!entry) {
    return
  }
  entry.leaseCount = Math.max(0, entry.leaseCount - 1)
  if (entry.leaseCount > 0) {
    return
  }
  // Why: only the last consumer cancels an in-flight full-tree scan (#7721).
  if (entry.activeRequestToken && entry.cancelLoad) {
    const token = entry.activeRequestToken
    entry.activeRequestToken = null
    entry.loadPromise = null
    const cancel = entry.cancelLoad
    entry.cancelLoad = null
    cancel(token)
  }
}

/** @deprecated use releaseTerminalWorktreePathIndexLease */
export function cancelTerminalWorktreePathIndexLoad(
  worktreeId: string,
  worktreePath: string,
  ownerKey: TerminalWorktreePathIndexOwnerKey
): void {
  releaseTerminalWorktreePathIndexLease(worktreeId, worktreePath, ownerKey)
}

export function resetTerminalWorktreePathIndexForTests(): void {
  indexesByKey.clear()
}

// Test helper: inject a ready index without going through listFiles.
export function seedTerminalWorktreePathIndexForTests(
  worktreeId: string,
  worktreePath: string,
  relativePaths: readonly string[],
  ownerKey: TerminalWorktreePathIndexOwnerKey = 'local'
): void {
  indexesByKey.set(indexKey(worktreeId, worktreePath, ownerKey), {
    relativePaths: new Set(relativePaths.map(normalizeWorktreeRelativePathKey)),
    loadedAt: Date.now(),
    loadPromise: null,
    activeRequestToken: null,
    cancelLoad: null,
    listRelativePaths: null,
    leaseCount: 1
  })
}
