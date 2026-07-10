import { lstat, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { isBinaryBuffer } from './binary-buffer'
import { decodeGitCQuotedPath } from './git-cquoted-path'
import { DEFAULT_GIT_STATUS_LIMIT } from './git-status-limit'

export type GitLineStats = { added?: number; removed?: number }

// Limits how many untracked files we read at once when counting their lines,
// so a worktree with thousands of new files cannot exhaust file descriptors.
const UNTRACKED_READ_CONCURRENCY = 8
// Keep status polling cheap: large untracked files are commonly generated
// assets, and reading them every poll can stall the source-control sidebar.
export const MAX_UNTRACKED_LINE_COUNT_BYTES = 2 * 1024 * 1024
// Why: the cache must hold at least one full status scan's untracked set
// (capped at DEFAULT_GIT_STATUS_LIMIT entries). A smaller cache is worse than
// none: a sequential scan over more files than the cap evicts every entry
// before the next poll revisits it, so every poll re-reads every untracked
// file's contents (#8013). 2x leaves headroom for a second window polling a
// different worktree; entries are ~200 bytes, so worst case is a few MB.
const UNTRACKED_STATS_CACHE_MAX_ENTRIES = 2 * DEFAULT_GIT_STATUS_LIMIT
const NEWLINE_BYTE = 0x0a

type CachedUntrackedStats = {
  size: number
  mtimeMs: number
  ctimeMs: number
  stats: GitLineStats
}

const untrackedStatsCache = new Map<string, CachedUntrackedStats>()

function parseNumstatCount(value: string): number | undefined {
  // git reports binary files as '-' in the numstat columns.
  if (value === '-') {
    return undefined
  }
  const count = Number.parseInt(value, 10)
  return Number.isFinite(count) ? count : undefined
}

// `git diff -M` reports renames in the numstat path column as `old => new` or
// `dir/{old => new}/file`; normalize to the post-rename path so it keys to the
// porcelain status entry, which always reports the new path.
function normalizeNumstatPath(rawPath: string): string {
  const decodedPath = decodeGitCQuotedPath(rawPath)
  const braced = /^(.*)\{(.+) => (.+)\}(.*)$/.exec(decodedPath)
  if (braced) {
    return `${braced[1]}${braced[3]}${braced[4]}`
  }
  const marker = ' => '
  const markerIndex = decodedPath.lastIndexOf(marker)
  return markerIndex === -1 ? decodedPath : decodedPath.slice(markerIndex + marker.length)
}

export function parseNumstat(stdout: string): Map<string, GitLineStats> {
  if (stdout.includes('\0')) {
    return parseNulDelimitedNumstat(stdout)
  }

  const stats = new Map<string, GitLineStats>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const parts = line.split('\t')
    const rawPath = parts.slice(2).join('\t')
    if (!rawPath) {
      continue
    }
    stats.set(normalizeNumstatPath(rawPath), {
      added: parseNumstatCount(parts[0] ?? ''),
      removed: parseNumstatCount(parts[1] ?? '')
    })
  }
  return stats
}

function parseNulDelimitedNumstat(stdout: string): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>()
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record) {
      continue
    }
    const parts = record.split('\t')
    const rawPath = parts.slice(2).join('\t')
    let path = rawPath
    if (!path) {
      // Git -z emits rename paths as: "added<TAB>removed<TAB>\0old\0new\0".
      // The split record has an empty path in the header; the postimage is next.
      i += 2
      path = records[i] ?? ''
    }
    if (!path) {
      continue
    }
    stats.set(path, {
      added: parseNumstatCount(parts[0] ?? ''),
      removed: parseNumstatCount(parts[1] ?? '')
    })
  }
  return stats
}

async function countFileAdditions(absolutePath: string): Promise<GitLineStats> {
  try {
    const fileStat = await lstat(absolutePath)
    const cached = untrackedStatsCache.get(absolutePath)
    if (
      cached &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.ctimeMs === fileStat.ctimeMs
    ) {
      // Why: Map eviction below removes the oldest-inserted key; re-inserting
      // on hit makes that LRU instead of FIFO, so a hot worktree's entries
      // survive another worktree's scan sharing this cache.
      untrackedStatsCache.delete(absolutePath)
      untrackedStatsCache.set(absolutePath, cached)
      return cached.stats
    }
    if (fileStat.isSymbolicLink()) {
      return rememberUntrackedStats(absolutePath, fileStat, { added: 1 })
    }
    if (!fileStat.isFile() || fileStat.size > MAX_UNTRACKED_LINE_COUNT_BYTES) {
      return rememberUntrackedStats(absolutePath, fileStat, {})
    }
    const buffer = await readFile(absolutePath)
    if (isBinaryBuffer(buffer)) {
      return rememberUntrackedStats(absolutePath, fileStat, {})
    }
    if (buffer.length === 0) {
      return rememberUntrackedStats(absolutePath, fileStat, { added: 0 })
    }
    let newlineCount = 0
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] === NEWLINE_BYTE) {
        newlineCount += 1
      }
    }
    // A trailing newline marks the final line as complete; without one the last
    // partial line still counts as an added line (matching git's numstat).
    const endsWithNewline = buffer.at(-1) === NEWLINE_BYTE
    return rememberUntrackedStats(absolutePath, fileStat, {
      added: endsWithNewline ? newlineCount : newlineCount + 1
    })
  } catch {
    return {}
  }
}

function rememberUntrackedStats(
  absolutePath: string,
  fileStat: { size: number; mtimeMs: number; ctimeMs: number },
  stats: GitLineStats
): GitLineStats {
  // Why: delete-before-set keeps refreshed entries at the recent end of the
  // Map's insertion order, preserving the LRU eviction contract.
  untrackedStatsCache.delete(absolutePath)
  untrackedStatsCache.set(absolutePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    stats
  })
  if (untrackedStatsCache.size > UNTRACKED_STATS_CACHE_MAX_ENTRIES) {
    const oldestKey = untrackedStatsCache.keys().next().value
    if (oldestKey) {
      untrackedStatsCache.delete(oldestKey)
    }
  }
  return stats
}

// Untracked files have no git-tracked baseline, so `git diff` ignores them.
// We count their contents directly to show an additions magnitude.
export async function collectUntrackedAdditions(
  worktreePath: string,
  untrackedPaths: readonly string[]
): Promise<Map<string, GitLineStats>> {
  const result = new Map<string, GitLineStats>()
  for (let i = 0; i < untrackedPaths.length; i += UNTRACKED_READ_CONCURRENCY) {
    const chunk = untrackedPaths.slice(i, i + UNTRACKED_READ_CONCURRENCY)
    await Promise.all(
      chunk.map(async (relativePath) => {
        result.set(relativePath, await countFileAdditions(path.join(worktreePath, relativePath)))
      })
    )
  }
  return result
}

export function applyLineStats(
  entry: { added?: number; removed?: number },
  stats: GitLineStats | undefined
): void {
  if (!stats) {
    return
  }
  if (stats.added !== undefined) {
    entry.added = stats.added
  }
  if (stats.removed !== undefined) {
    entry.removed = stats.removed
  }
}
