import type { Dir, Dirent } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isCursorSidecarScanCancelledError } from './cursor-sidecar-scan-cancellation'

export type CursorDirectoryStream = Pick<Dir, 'close' | 'read'> & AsyncIterable<Dirent>

/** Per-directory dirent examination budget; keeps cold scans hard-bounded. */
export const CURSOR_DIR_MAX_ENTRIES_EXAMINED = 8_192

// Filesystem keys need identical ordering across host locales.
export function compareCursorSidecarNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Returns true when `name` caused the retained set to overflow the limit. */
export function retainLexicographic(selected: string[], name: string, limit: number): boolean {
  if (selected.length < limit) {
    selected.push(name)
    if (selected.length === limit) {
      selected.sort(compareCursorSidecarNames)
    }
    return false
  }
  const last = selected[limit - 1]
  if (compareCursorSidecarNames(name, last) >= 0) {
    return true
  }
  let low = 0
  let high = limit
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareCursorSidecarNames(name, selected[middle]) < 0) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  selected.splice(low, 0, name)
  selected.pop()
  return true
}

export type StreamDirectoryNamesOptions = {
  /** Invoked once per examined dirent (not the overflow probe). */
  onDirent?: () => void
  /** Hard stop after this many dirents; default CURSOR_DIR_MAX_ENTRIES_EXAMINED. */
  maxEntriesExamined?: number
  opendir?: (path: string) => Promise<CursorDirectoryStream>
}

type StreamDirectoryIo = {
  opendir: (path: string) => Promise<CursorDirectoryStream>
}

const defaultStreamDirectoryIo: StreamDirectoryIo = {
  opendir
}
let streamDirectoryIo: StreamDirectoryIo = defaultStreamDirectoryIo

/** Test isolation for streamed and unsupported directory paths. */
export function setStreamDirectoryIoForTests(next?: Partial<StreamDirectoryIo>): void {
  streamDirectoryIo = next
    ? {
        opendir: next.opendir ?? defaultStreamDirectoryIo.opendir
      }
    : defaultStreamDirectoryIo
}

/**
 * Streams directory names without materializing the full listing on opendir hosts.
 * Retention callers keep only their bounded selection; examination stops at
 * maxEntriesExamined. One extra dirent is read as an overflow probe so stopping
 * exactly at the budget still reports examinationTruncated truthfully when more
 * entries exist.
 */
export async function streamDirectoryNames(
  dirPath: string,
  visit: (name: string, entry: Dirent) => void,
  options: StreamDirectoryNamesOptions = {}
): Promise<{ entriesExamined: number; examinationTruncated: boolean }> {
  const maxEntries = options.maxEntriesExamined ?? CURSOR_DIR_MAX_ENTRIES_EXAMINED
  if (maxEntries <= 0) {
    return { entriesExamined: 0, examinationTruncated: true }
  }

  try {
    const directory = await (options.opendir ?? streamDirectoryIo.opendir)(dirPath)
    try {
      return await examineDirectoryStream(directory, visit, options, maxEntries)
    } finally {
      // Closing mid-iteration is best-effort; for-await also closes on break/throw.
      await directory.close().catch(() => undefined)
    }
  } catch (error) {
    if (!isUnsupportedDirectoryStream(error)) {
      throw error
    }
    // readdir is eager and cannot preserve this function's memory/IO bound.
    return { entriesExamined: 0, examinationTruncated: true }
  }
}

/**
 * Deterministic retention: among accepted names in the first maxEntriesExamined
 * dirents (opendir/readdir order), keep the lexicographic first `limit`.
 * Does not materialize the full directory; only the retained name set is kept.
 */
export async function listLexicographicDirectoryNames(args: {
  dirPath: string
  limit: number
  accept: (name: string, entry: Dirent) => boolean
  maxEntriesExamined?: number
  onDirent?: () => void
  opendir?: (path: string) => Promise<CursorDirectoryStream>
}): Promise<{
  names: string[]
  truncated: boolean
  entriesExamined: number
  direntsRead: number
}> {
  if (args.limit <= 0) {
    return { names: [], truncated: true, entriesExamined: 0, direntsRead: 0 }
  }
  const selected: string[] = []
  let truncated = false
  const { entriesExamined, examinationTruncated } = await streamDirectoryNames(
    args.dirPath,
    (name, entry) => {
      if (!args.accept(name, entry)) {
        return
      }
      if (retainLexicographic(selected, name, args.limit)) {
        truncated = true
      }
    },
    {
      maxEntriesExamined: args.maxEntriesExamined,
      onDirent: args.onDirent,
      opendir: args.opendir
    }
  )
  if (examinationTruncated) {
    truncated = true
  }
  if (selected.length < args.limit) {
    selected.sort(compareCursorSidecarNames)
  }
  const direntsRead = entriesExamined + Number(examinationTruncated && entriesExamined > 0)
  return { names: selected, truncated, entriesExamined, direntsRead }
}

export function targetPathVariants(value: string, pathPlatform: NodeJS.Platform): string[] {
  const pathOps = pathPlatform === 'win32' ? win32 : posix
  if (!pathOps.isAbsolute(value)) {
    return []
  }
  const resolved = pathOps.resolve(value)
  if (pathPlatform !== 'win32') {
    return [resolved]
  }
  const match = /^([A-Za-z]):/u.exec(resolved)
  return match
    ? [
        ...new Set([
          resolved,
          `${match[1].toUpperCase()}${resolved.slice(1)}`,
          `${match[1].toLowerCase()}${resolved.slice(1)}`
        ])
      ]
    : [resolved]
}

export async function resolveTargetScopePathVariants(args: {
  value: string
  pathPlatform: NodeJS.Platform
  resolveScopePaths?: (scopePath: string) => Promise<readonly string[]>
  realpathPath?: (path: string) => Promise<string>
}): Promise<readonly string[]> {
  if (args.resolveScopePaths) {
    return args.resolveScopePaths(args.value)
  }
  const variants = targetPathVariants(args.value, args.pathPlatform)
  try {
    variants.push(
      ...targetPathVariants(await (args.realpathPath ?? realpath)(args.value), args.pathPlatform)
    )
  } catch (error) {
    if (isCursorSidecarScanCancelledError(error)) {
      throw error
    }
    // A scope path need not exist on the owning host.
  }
  return variants
}

export function safeBasename(value: string): boolean {
  return Boolean(value && value !== '.' && value !== '..' && !/[\\/]/u.test(value))
}

async function examineDirectoryStream(
  directory: CursorDirectoryStream,
  visit: (name: string, entry: Dirent) => void,
  options: StreamDirectoryNamesOptions,
  maxEntries: number
): Promise<{ entriesExamined: number; examinationTruncated: boolean }> {
  let entriesExamined = 0
  let examinationTruncated = false
  for await (const entry of directory) {
    // Bounded overflow probe: reading one dirent past the budget proves that
    // stopping exactly at maxEntries is truncation, without visiting it.
    if (entriesExamined >= maxEntries) {
      examinationTruncated = true
      break
    }
    entriesExamined += 1
    options.onDirent?.()
    visit(entry.name, entry)
  }
  return { entriesExamined, examinationTruncated }
}

function isUnsupportedDirectoryStream(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || code === 'ENOTSUP'
}
