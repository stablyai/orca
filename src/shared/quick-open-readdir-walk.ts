import { lstat, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  HIDDEN_DIR_BLOCKLIST,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from './quick-open-filter'

export const QUICK_OPEN_READDIR_MAX_FILES = 10_000
export const QUICK_OPEN_READDIR_TIMEOUT_MS = 10_000

export type QuickOpenReaddirBudget = {
  remainingFiles: number
  deadlineMs: number
}

export type QuickOpenGitEntryKind = 'keep' | 'fill-nested-repo' | 'drop-placeholder'

export type QuickOpenGitLsFilesEntry = {
  path: string
  isGitlink: boolean
  isUntrackedDir: boolean
}

const GIT_LS_FILES_STAGE_ENTRY = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t/

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

export function createQuickOpenReaddirBudget(
  opts: { maxFiles?: number; timeoutMs?: number; nowMs?: number } = {}
): QuickOpenReaddirBudget {
  return {
    remainingFiles: opts.maxFiles ?? QUICK_OPEN_READDIR_MAX_FILES,
    deadlineMs: (opts.nowMs ?? Date.now()) + (opts.timeoutMs ?? QUICK_OPEN_READDIR_TIMEOUT_MS)
  }
}

const FILE_LISTING_TIMED_OUT = 'File listing timed out'
const FILE_LISTING_EXCEEDED_PREFIX = 'File listing exceeded'

/**
 * Why: the readdir walk can exhaust its cap/deadline even on the git path (a
 * git monorepo parent with a huge nested repo). Callers translate only these
 * budget errors into "install rg" guidance, leaving genuine git failures with
 * their own messages.
 */
export function isQuickOpenReaddirBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return message === FILE_LISTING_TIMED_OUT || message.startsWith(FILE_LISTING_EXCEEDED_PREFIX)
}

function assertWithinDeadline(budget: QuickOpenReaddirBudget): void {
  if (Date.now() > budget.deadlineMs) {
    throw new Error(FILE_LISTING_TIMED_OUT)
  }
}

function consumeFileBudget(budget: QuickOpenReaddirBudget): void {
  if (budget.remainingFiles <= 0) {
    throw new Error(`${FILE_LISTING_EXCEEDED_PREFIX} ${QUICK_OPEN_READDIR_MAX_FILES} files`)
  }
  budget.remainingFiles--
}

function shouldDescend(name: string): boolean {
  return name !== 'node_modules' && !HIDDEN_DIR_BLOCKLIST.has(name)
}

function toRelPath(rootPath: string, absPath: string): string {
  // Why: path.relative returns backslashes on Windows, while Quick Open paths
  // are always stored and matched with POSIX separators.
  return relative(rootPath, absPath).replace(/\\/g, '/')
}

function joinRootRel(rootPath: string, relPath: string): string {
  return join(rootPath, ...relPath.split('/').filter(Boolean))
}

function normalizeGitEntry(entry: string): string {
  return entry.replace(/\/+$/, '')
}

// Translate workspace-root-relative exclude prefixes into prefixes relative to
// a nested repo at `nestedRelPath`, so the nested walk can prune them during
// traversal. Prefixes outside the nested repo are dropped (they cannot match).
function rebaseExcludePrefixesForNestedRepo(
  excludePathPrefixes: readonly string[],
  nestedRelPath: string
): string[] {
  const base = `${nestedRelPath}/`
  const rebased: string[] = []
  for (const prefix of excludePathPrefixes) {
    if (prefix.startsWith(base)) {
      rebased.push(prefix.slice(base.length))
    }
  }
  return rebased
}

async function hasGitEntry(absPath: string): Promise<boolean> {
  try {
    const stat = await lstat(join(absPath, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

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

export async function listQuickOpenFilesWithReaddir(
  rootPath: string,
  opts: {
    excludePathPrefixes?: readonly string[]
    budget?: QuickOpenReaddirBudget
  } = {}
): Promise<string[]> {
  const files: string[] = []
  const budget = opts.budget ?? createQuickOpenReaddirBudget()
  const excludePathPrefixes = opts.excludePathPrefixes ?? []

  async function walk(dir: string): Promise<void> {
    assertWithinDeadline(budget)

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Why: permission denied on an individual subtree is common for broad
      // roots. Skipping that subtree preserves the existing relay fallback.
      return
    }

    for (const entry of entries) {
      assertWithinDeadline(budget)

      const name = entry.name
      const absPath = join(dir, name)
      const relPath = toRelPath(rootPath, absPath)
      if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
        continue
      }
      if (entry.isDirectory()) {
        if (shouldDescend(name)) {
          await walk(absPath)
        }
        continue
      }
      if (entry.isFile()) {
        consumeFileBudget(budget)
        files.push(relPath)
      }
    }
  }

  await walk(rootPath)
  return files
}

export async function expandQuickOpenGitFilesWithNestedRepos(opts: {
  rootPath: string
  gitPaths: Iterable<string>
  excludePathPrefixes?: readonly string[]
  budget?: QuickOpenReaddirBudget
}): Promise<string[]> {
  const files = new Set<string>()
  const excludePathPrefixes = opts.excludePathPrefixes ?? []
  const budget = opts.budget ?? createQuickOpenReaddirBudget()

  const addFinalPath = (relPath: string): void => {
    if (!relPath) {
      return
    }
    if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
      return
    }
    if (shouldIncludeQuickOpenPath(relPath)) {
      files.add(relPath)
    }
  }

  for (const rawPath of opts.gitPaths) {
    assertWithinDeadline(budget)

    const { kind, relPath } = await classifyQuickOpenGitEntry(opts.rootPath, rawPath)
    if (kind === 'keep') {
      addFinalPath(relPath)
      continue
    }
    if (kind === 'drop-placeholder') {
      continue
    }

    const nestedFiles = await listQuickOpenFilesWithReaddir(joinRootRel(opts.rootPath, relPath), {
      // Why: exclude prefixes are workspace-root-relative; rebase them onto the
      // nested repo so the walk prunes excluded subtrees during traversal
      // instead of burning the shared budget and filtering them at the end.
      excludePathPrefixes: rebaseExcludePrefixesForNestedRepo(excludePathPrefixes, relPath),
      budget
    })
    for (const nestedFile of nestedFiles) {
      addFinalPath(`${relPath}/${nestedFile}`)
    }
  }

  return Array.from(files)
}
