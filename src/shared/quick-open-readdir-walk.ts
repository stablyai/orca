import { lstat, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { throwIfFileListingCancelled } from './file-listing-cancellation'
import { isQuickOpenReadableDirectory } from './quick-open-directory-validation'
import { collapseQuickOpenExpansionPaths } from './quick-open-expansion-paths'
import {
  HIDDEN_DIR_BLOCKLIST,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from './quick-open-filter'

export const QUICK_OPEN_READDIR_MAX_FILES = 10_000
export const QUICK_OPEN_READDIR_TIMEOUT_MS = 10_000
const QUICK_OPEN_READDIR_CONCURRENCY = 32

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
// one expanded subtree, so its walk prunes them during traversal. Prefixes
// outside that subtree are dropped because they cannot match.
function rebaseExcludePrefixesForSubtree(
  excludePathPrefixes: readonly string[],
  subtreeRelPath: string
): string[] {
  const base = `${subtreeRelPath}/`
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
    workspaceRelPathPrefix?: string
    budget?: QuickOpenReaddirBudget
    signal?: AbortSignal
  } = {}
): Promise<string[]> {
  return listQuickOpenFilesFromRoots(
    [
      {
        rootPath,
        excludePathPrefixes: opts.excludePathPrefixes ?? [],
        workspaceRelPathPrefix: opts.workspaceRelPathPrefix,
        allowRootSymlink: true
      }
    ],
    opts.budget ?? createQuickOpenReaddirBudget(),
    opts.signal
  )
}

type QuickOpenReaddirRoot = {
  rootPath: string
  excludePathPrefixes: readonly string[]
  workspaceRelPathPrefix?: string
  outputPathPrefix?: string
  includeSymlinks?: boolean
  allowRootSymlink?: boolean
}

async function listQuickOpenFilesFromRoots(
  roots: readonly QuickOpenReaddirRoot[],
  budget: QuickOpenReaddirBudget,
  signal?: AbortSignal
): Promise<string[]> {
  const files: string[] = []
  let pendingDirectories = roots.map((root) => ({
    root,
    absPath: root.rootPath,
    isRoot: true
  }))

  while (pendingDirectories.length > 0) {
    const nextDirectories: typeof pendingDirectories = []
    for (
      let offset = 0;
      offset < pendingDirectories.length;
      offset += QUICK_OPEN_READDIR_CONCURRENCY
    ) {
      // Why: batch only the filesystem calls. Result processing stays serial,
      // so the shared cap remains exact while shallow placeholder-heavy repos
      // do not pay one relay event-loop turn per directory.
      throwIfFileListingCancelled(signal)
      assertWithinDeadline(budget)
      const batch = pendingDirectories.slice(offset, offset + QUICK_OPEN_READDIR_CONCURRENCY)
      const entryGroups = await Promise.all(
        batch.map(async (pending) => {
          try {
            // Why: Git's placeholder may have been replaced with a symlink
            // before expansion. Never let readdir follow it outside the root.
            const stat = await lstat(pending.absPath)
            const allowSymlinkedRoot = pending.isRoot && pending.root.allowRootSymlink
            if (!isQuickOpenReadableDirectory(stat, allowSymlinkedRoot)) {
              return { pending, entries: [] }
            }
            const entries = await readdir(pending.absPath, { withFileTypes: true })
            // Why: close the ordinary check/use race. If the directory became
            // a symlink while readdir was pending, discard everything read.
            const statAfterRead = await lstat(pending.absPath)
            if (!isQuickOpenReadableDirectory(statAfterRead, allowSymlinkedRoot)) {
              return { pending, entries: [] }
            }
            return { pending, entries }
          } catch {
            // Why: permission denied on one subtree is common for broad roots.
            return { pending, entries: [] }
          }
        })
      )
      // Why: an empty directory has no per-entry checkpoint below. Cancellation
      // or timeout that lands during readdir must still reject, never resolve [].
      throwIfFileListingCancelled(signal)
      assertWithinDeadline(budget)

      for (const { pending, entries } of entryGroups) {
        for (const entry of entries) {
          throwIfFileListingCancelled(signal)
          assertWithinDeadline(budget)

          const name = entry.name
          const absPath = join(pending.absPath, name)
          const relPath = toRelPath(pending.root.rootPath, absPath)
          const workspaceRelPath = pending.root.workspaceRelPathPrefix
            ? `${pending.root.workspaceRelPathPrefix}/${relPath}`
            : relPath
          if (shouldExcludeQuickOpenRelPath(relPath, pending.root.excludePathPrefixes)) {
            continue
          }
          if (entry.isDirectory()) {
            if (shouldDescend(name) && shouldIncludeQuickOpenPath(workspaceRelPath)) {
              nextDirectories.push({ root: pending.root, absPath, isRoot: false })
            }
            continue
          }
          if (
            (entry.isFile() || (pending.root.includeSymlinks && entry.isSymbolicLink())) &&
            shouldIncludeQuickOpenPath(workspaceRelPath)
          ) {
            consumeFileBudget(budget)
            files.push(
              pending.root.outputPathPrefix
                ? `${pending.root.outputPathPrefix}/${relPath}`
                : relPath
            )
          }
        }
      }
    }
    pendingDirectories = nextDirectories
  }

  return files
}

export async function expandQuickOpenGitFileListing(opts: {
  rootPath: string
  gitPaths: Iterable<string>
  directoryPaths?: Iterable<string>
  excludePathPrefixes?: readonly string[]
  budget?: QuickOpenReaddirBudget
  signal?: AbortSignal
}): Promise<string[]> {
  const files = new Set<string>()
  const excludePathPrefixes = opts.excludePathPrefixes ?? []
  const budget = opts.budget ?? createQuickOpenReaddirBudget()
  const expansionPaths = new Map<string, boolean>()

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
    throwIfFileListingCancelled(opts.signal)
    assertWithinDeadline(budget)

    const { kind, relPath } = await classifyQuickOpenGitEntry(opts.rootPath, rawPath)
    if (kind === 'keep') {
      addFinalPath(relPath)
      continue
    }
    if (kind === 'drop-placeholder') {
      continue
    }

    expansionPaths.set(relPath, expansionPaths.get(relPath) ?? false)
  }

  for (const rawPath of opts.directoryPaths ?? []) {
    throwIfFileListingCancelled(opts.signal)
    assertWithinDeadline(budget)

    const relPath = normalizeGitEntry(rawPath)
    // Why: Git intentionally leaves collapsed directories unexpanded; reject
    // blocked and nested-worktree placeholders before any filesystem IO.
    if (
      !relPath ||
      shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes) ||
      !shouldIncludeQuickOpenPath(relPath)
    ) {
      continue
    }

    // Why: before directory collapse, Git returned untracked symlink entries
    // without following them. Preserve those paths when expanding placeholders.
    expansionPaths.set(relPath, true)
  }

  const expandedFiles = await listQuickOpenFilesFromRoots(
    collapseQuickOpenExpansionPaths(expansionPaths).map(([relPath, includeSymlinks]) => ({
      rootPath: joinRootRel(opts.rootPath, relPath),
      // Why: exclude prefixes are workspace-root-relative; rebase them onto
      // each expanded subtree so blocked work is pruned before consuming cap.
      excludePathPrefixes: rebaseExcludePrefixesForSubtree(excludePathPrefixes, relPath),
      // Why: Git can collapse `.local/share/` to `.local/`; keep workspace
      // context so the walker still prunes the multi-segment blocklist.
      workspaceRelPathPrefix: relPath,
      outputPathPrefix: relPath,
      includeSymlinks
    })),
    budget,
    opts.signal
  )
  for (const expandedFile of expandedFiles) {
    addFinalPath(expandedFile)
  }

  return Array.from(files)
}
