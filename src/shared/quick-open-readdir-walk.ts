import { join, relative } from 'node:path'
import { throwIfFileListingCancelled } from './file-listing-cancellation'
import { readQuickOpenDirectoryEntries } from './quick-open-directory-reader'
import { collapseQuickOpenExpansionPaths } from './quick-open-expansion-paths'
import { classifyQuickOpenGitEntry } from './quick-open-git-entry-classification'
import {
  HIDDEN_DIR_BLOCKLIST,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from './quick-open-filter'
import {
  assertQuickOpenReaddirDepth,
  assertQuickOpenReaddirDeadline,
  consumeQuickOpenReaddirDirectoryBudget,
  consumeQuickOpenReaddirEntryBudget,
  consumeQuickOpenReaddirFileBudget,
  consumeQuickOpenReaddirPathBudget,
  createQuickOpenReaddirBudget,
  type QuickOpenReaddirBudget
} from './quick-open-readdir-budget'

export {
  classifyQuickOpenGitEntry,
  parseQuickOpenGitLsFilesEntry,
  type QuickOpenGitEntryKind,
  type QuickOpenGitLsFilesEntry
} from './quick-open-git-entry-classification'

export {
  createQuickOpenReaddirBudget,
  isQuickOpenReaddirBudgetError,
  QUICK_OPEN_READDIR_MAX_DEPTH,
  QUICK_OPEN_READDIR_MAX_DIRECTORIES,
  QUICK_OPEN_READDIR_MAX_ENTRIES,
  QUICK_OPEN_READDIR_MAX_FILES,
  QUICK_OPEN_READDIR_MAX_PATH_CODE_UNITS,
  QUICK_OPEN_READDIR_TIMEOUT_MS
} from './quick-open-readdir-budget'

const QUICK_OPEN_READDIR_CONCURRENCY = 32

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

export async function listQuickOpenFilesWithReaddir(
  rootPath: string,
  opts: {
    excludePathPrefixes?: readonly string[]
    workspaceRelPathPrefix?: string
    budget?: QuickOpenReaddirBudget
    maxResults?: number
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
    opts.signal,
    opts.maxResults
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
  signal?: AbortSignal,
  maxResults?: number,
  knownFiles?: ReadonlySet<string>
): Promise<string[]> {
  const files: string[] = []
  if (maxResults !== undefined && maxResults <= 0) {
    return files
  }
  let pendingDirectories: {
    root: QuickOpenReaddirRoot
    absPath: string
    depth: number
    isRoot: boolean
  }[] = []
  for (const root of roots) {
    assertQuickOpenReaddirDepth(budget, 0)
    consumeQuickOpenReaddirDirectoryBudget(budget)
    consumeQuickOpenReaddirPathBudget(budget, root.rootPath)
    pendingDirectories.push({ root, absPath: root.rootPath, depth: 0, isRoot: true })
  }

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
      assertQuickOpenReaddirDeadline(budget)
      const batch = pendingDirectories.slice(offset, offset + QUICK_OPEN_READDIR_CONCURRENCY)
      const readResults = await Promise.allSettled(
        batch.map(async (pending) => {
          const entries = await readQuickOpenDirectoryEntries({
            absPath: pending.absPath,
            allowSymlinkedRoot: Boolean(pending.isRoot && pending.root.allowRootSymlink),
            budget,
            signal
          })
          return { pending, entries }
        })
      )
      const entryGroups: {
        pending: (typeof pendingDirectories)[number]
        entries: Awaited<ReturnType<typeof readQuickOpenDirectoryEntries>>
      }[] = []
      for (const result of readResults) {
        if (result.status === 'rejected') {
          throw result.reason
        }
        entryGroups.push(result.value)
      }
      // Why: an empty directory has no per-entry checkpoint below. Cancellation
      // or timeout that lands during opendir must still reject, never resolve [].
      throwIfFileListingCancelled(signal)
      assertQuickOpenReaddirDeadline(budget)

      for (const { pending, entries } of entryGroups) {
        for (const entry of entries) {
          throwIfFileListingCancelled(signal)
          assertQuickOpenReaddirDeadline(budget)

          const name = entry.name
          const absPath = join(pending.absPath, name)
          const relPath = toRelPath(pending.root.rootPath, absPath)
          const workspaceRelPath = pending.root.workspaceRelPathPrefix
            ? `${pending.root.workspaceRelPathPrefix}/${relPath}`
            : relPath
          if (shouldExcludeQuickOpenRelPath(relPath, pending.root.excludePathPrefixes)) {
            continue
          }
          if (entry.kind === 'directory') {
            if (shouldDescend(name) && shouldIncludeQuickOpenPath(workspaceRelPath)) {
              const depth = pending.depth + 1
              assertQuickOpenReaddirDepth(budget, depth)
              consumeQuickOpenReaddirDirectoryBudget(budget)
              consumeQuickOpenReaddirPathBudget(budget, absPath)
              nextDirectories.push({ root: pending.root, absPath, depth, isRoot: false })
            }
            continue
          }
          if (
            (entry.kind === 'file' || (pending.root.includeSymlinks && entry.kind === 'symlink')) &&
            shouldIncludeQuickOpenPath(workspaceRelPath)
          ) {
            const outputPath = pending.root.outputPathPrefix
              ? `${pending.root.outputPathPrefix}/${relPath}`
              : relPath
            if (knownFiles?.has(outputPath)) {
              continue
            }
            consumeQuickOpenReaddirFileBudget(budget)
            consumeQuickOpenReaddirPathBudget(budget, outputPath)
            files.push(outputPath)
            // Why: a caller result limit is a successful bounded prefix, while
            // the separate traversal budget still rejects incomplete scans.
            if (maxResults !== undefined && files.length >= maxResults) {
              return files
            }
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
  maxResults?: number
  signal?: AbortSignal
}): Promise<string[]> {
  if (opts.maxResults !== undefined && opts.maxResults <= 0) {
    return []
  }
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
    assertQuickOpenReaddirDeadline(budget)

    const { kind, relPath } = await classifyQuickOpenGitEntry(opts.rootPath, rawPath)
    if (kind === 'keep') {
      addFinalPath(relPath)
      continue
    }
    if (kind === 'drop-placeholder') {
      continue
    }

    consumeQuickOpenReaddirEntryBudget(budget)
    consumeQuickOpenReaddirPathBudget(budget, relPath)
    expansionPaths.set(relPath, expansionPaths.get(relPath) ?? false)
  }

  for (const rawPath of opts.directoryPaths ?? []) {
    throwIfFileListingCancelled(opts.signal)
    assertQuickOpenReaddirDeadline(budget)

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

    consumeQuickOpenReaddirEntryBudget(budget)
    consumeQuickOpenReaddirPathBudget(budget, relPath)
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
    opts.signal,
    opts.maxResults === undefined ? undefined : Math.max(0, opts.maxResults - files.size),
    files
  )
  for (const expandedFile of expandedFiles) {
    addFinalPath(expandedFile)
  }

  return Array.from(files).slice(0, opts.maxResults)
}
