import { lstat } from 'node:fs/promises'
import * as path from 'node:path'
import { isBinaryBuffer } from './binary-buffer'
import { decodeGitCQuotedPath } from './git-cquoted-path'
import { DEFAULT_GIT_STATUS_LIMIT } from './git-status-limit'
import { iterateNulDelimitedFields } from './nul-delimited-fields'
import { readNodeFileWithinLimit } from './node-bounded-file-reader'

export type GitLineStats = { added?: number; removed?: number }

// Bound untracked line-count reads to avoid exhausting descriptors in large worktrees.
const UNTRACKED_READ_CONCURRENCY = 8
// Skip large untracked assets so polling cannot stall the sidebar.
export const MAX_UNTRACKED_LINE_COUNT_BYTES = 2 * 1024 * 1024
// Hold at least a full capped scan or sequential reads evict everything before the next poll (#8013).
// 2× leaves headroom for another window/worktree; ~200-byte entries keep memory within a few MB.
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

// Normalize -M old => new and dir/{old => new}/file to post-rename paths used by porcelain status.
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

export function parseNumstat(
  stdout: string,
  onRenameSource?: (path: string) => void
): Map<string, GitLineStats> {
  if (stdout.includes('\0')) {
    return parseNulDelimitedNumstat(stdout, onRenameSource)
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

function parseNulDelimitedNumstat(
  stdout: string,
  onRenameSource?: (path: string) => void
): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>()
  const records = iterateNulDelimitedFields(stdout)[Symbol.iterator]()
  for (let next = records.next(); !next.done; next = records.next()) {
    const record = next.value
    if (!record) {
      continue
    }
    const parts = record.split('\t')
    const rawPath = parts.slice(2).join('\t')
    let path = rawPath
    if (!path) {
      // Git -z emits rename paths as: "added<TAB>removed<TAB>\0old\0new\0".
      // The empty header path is followed by the preimage and postimage.
      const oldPath = records.next().value
      if (oldPath) {
        onRenameSource?.(oldPath)
      }
      path = records.next().value ?? ''
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
      // Reinsert hits to make Map order LRU, protecting hot worktrees from other scans.
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
    const { buffer } = await readNodeFileWithinLimit(absolutePath, MAX_UNTRACKED_LINE_COUNT_BYTES)
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
    // A final partial line still counts as added, matching Git numstat.
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
  // Refresh at the Map’s recent end to preserve LRU eviction.
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

function createGitLineStatsAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** Untracked files have no Git baseline; read their contents directly to count additions. */
export async function collectUntrackedAdditions(
  worktreePath: string,
  untrackedPaths: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, GitLineStats>> {
  const result = new Map<string, GitLineStats>()
  for (let i = 0; i < untrackedPaths.length; i += UNTRACKED_READ_CONCURRENCY) {
    // Reject aborts instead of returning partial status counts; stop further local/remote I/O.
    if (signal?.aborted) {
      throw createGitLineStatsAbortError()
    }
    const chunk = untrackedPaths.slice(i, i + UNTRACKED_READ_CONCURRENCY)
    await Promise.all(
      chunk.map(async (relativePath) => {
        result.set(relativePath, await countFileAdditions(path.join(worktreePath, relativePath)))
      })
    )
  }
  if (signal?.aborted) {
    throw createGitLineStatsAbortError()
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
