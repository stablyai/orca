/**
 * Parsing and classification of `git ls-files` entries for Quick Open.
 * Split out of quick-open-readdir-walk.ts to keep that module under the
 * oxlint max-lines cap; the walk re-exports the public members so existing
 * importers and tests keep their `./quick-open-readdir-walk` path.
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

export type QuickOpenGitEntryKind = 'keep' | 'fill-nested-repo' | 'drop-placeholder'

export type QuickOpenGitLsFilesEntry = {
  path: string
  isGitlink: boolean
  isUntrackedDir: boolean
}

const GIT_LS_FILES_STAGE_ENTRY = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t/

/** Parse one `git ls-files -s -z` line into its path plus gitlink/untracked-dir flags. */
export function parseQuickOpenGitLsFilesEntry(entry: string): QuickOpenGitLsFilesEntry {
  const match = GIT_LS_FILES_STAGE_ENTRY.exec(entry)
  if (match) {
    return {
      path: entry.slice(match[0].length),
      isGitlink: match[1] === '160000',
      isUntrackedDir: false
    }
  }
  return {
    path: entry,
    isGitlink: false,
    isUntrackedDir: entry.endsWith('/')
  }
}

/** Join a root-relative POSIX path onto an absolute root, honoring the local separator. */
export function joinRootRel(rootPath: string, relPath: string): string {
  return join(rootPath, ...relPath.split('/').filter(Boolean))
}

/** Strip trailing slashes so a git directory placeholder compares as a plain path. */
export function normalizeGitEntry(entry: string): string {
  return entry.replace(/\/+$/, '')
}

/** True when `absPath` contains a `.git` dir or file — i.e. it is a nested repo root. */
async function hasGitEntry(absPath: string): Promise<boolean> {
  try {
    const stat = await lstat(join(absPath, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/**
 * Decide how Quick Open should treat one git ls-files entry: keep it as a file,
 * fill it in as a nested repo, or drop it as a stale placeholder.
 */
export async function classifyQuickOpenGitEntry(
  rootPath: string,
  entry: string
): Promise<{ kind: QuickOpenGitEntryKind; relPath: string }> {
  const parsed = parseQuickOpenGitLsFilesEntry(entry)
  const relPath = normalizeGitEntry(parsed.path)
  if (!relPath) {
    return { kind: 'drop-placeholder', relPath }
  }

  if (!parsed.isGitlink && !parsed.isUntrackedDir) {
    return { kind: 'keep', relPath }
  }

  let stat
  try {
    stat = await lstat(joinRootRel(rootPath, relPath))
  } catch {
    return { kind: 'drop-placeholder', relPath }
  }

  if (!stat.isDirectory()) {
    return { kind: 'drop-placeholder', relPath }
  }

  if (await hasGitEntry(joinRootRel(rootPath, relPath))) {
    return { kind: 'fill-nested-repo', relPath }
  }

  return { kind: 'drop-placeholder', relPath }
}
