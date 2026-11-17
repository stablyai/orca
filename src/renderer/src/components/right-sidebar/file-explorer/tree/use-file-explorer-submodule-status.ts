import { useEffect, useMemo, useRef, useState } from 'react'
import { onGitStatusRead } from '@/store/slices/editor/git/git-status-read-signal'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getRuntimeGitSubmoduleStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { getWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'
import { buildSubmoduleChildEntry } from '../../source-control/listing/submodule-expansion'
import {
  buildFolderStatusMap,
  buildStatusMap
} from '../../../../../../shared/git/status/git-path-decoration'

// Why: bounds parallel `git status` processes (and SSH round trips) without hiding any expanded submodule.
const SUBMODULE_STATUS_CONCURRENCY = 4

const NO_ENTRIES: GitStatusEntry[] = []

/** Dirty submodules the user has expanded; clean or collapsed ones never trigger inner Git work. */
export function selectExpandedDirtySubmodulePaths(
  entries: readonly GitStatusEntry[],
  expandedRelativePaths: ReadonlySet<string>
): string[] {
  const paths = new Set<string>()
  for (const entry of entries) {
    const submodule = entry.submodule
    if (!submodule || entry.submoduleRoot || entry.area === 'staged') {
      continue
    }
    if (!submodule.trackedChanges && !submodule.untrackedChanges) {
      continue
    }
    const path = normalizeRelativePath(entry.path)
    if (expandedRelativePaths.has(path)) {
      paths.add(path)
    }
  }
  return Array.from(paths).sort()
}

/** Parent-relative inner entries, or null on failure so callers keep the last good badges. */
async function readSubmoduleChildEntries(
  context: Parameters<typeof getRuntimeGitSubmoduleStatus>[0],
  submodulePath: string,
  inFlight: Set<string>,
  flightKey: string
): Promise<GitStatusEntry[] | null> {
  inFlight.add(flightKey)
  try {
    const status = await getRuntimeGitSubmoduleStatus(context, submodulePath)
    return status.entries.map((innerEntry) => buildSubmoduleChildEntry(submodulePath, innerEntry))
  } catch {
    // A transient remote failure must not look like a clean submodule.
    return null
  } finally {
    inFlight.delete(flightKey)
  }
}

type SubmoduleStatusResult = {
  scopeKey: string
  entriesByPath: Record<string, GitStatusEntry[]>
}

/** Parent-relative status entries for files inside expanded dirty submodules. */
export function useFileExplorerSubmoduleStatus({
  activeWorktreeId,
  worktreePath,
  entries,
  expanded
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  entries: readonly GitStatusEntry[]
  expanded: ReadonlySet<string>
}): GitStatusEntry[] {
  const scopeKey = `${activeWorktreeId ?? ''}\0${worktreePath ?? ''}`
  const [result, setResult] = useState<SubmoduleStatusResult>(() => ({
    scopeKey,
    entriesByPath: {}
  }))
  // Reset during render so a worktree switch cannot paint the previous one's badges.
  if (result.scopeKey !== scopeKey) {
    setResult({ scopeKey, entriesByPath: {} })
  }
  const [parentReadTick, setParentReadTick] = useState(0)
  const inFlight = useRef(new Set<string>())

  const submodulePathsKey = useMemo(() => {
    if (!worktreePath) {
      return ''
    }
    const expandedRelativePaths = new Set<string>()
    for (const path of expanded) {
      const relativePath = getRelativePathInsideRoot(path, worktreePath)
      if (relativePath) {
        expandedRelativePaths.add(normalizeRelativePath(relativePath))
      }
    }
    return selectExpandedDirtySubmodulePaths(entries, expandedRelativePaths).join('\0')
  }, [entries, expanded, worktreePath])

  // A second edit inside an already-dirty submodule leaves parent status identical, so follow every parent read.
  useEffect(() => {
    if (!activeWorktreeId || !submodulePathsKey) {
      return
    }
    return onGitStatusRead((worktreeId) => {
      if (worktreeId === activeWorktreeId) {
        setParentReadTick((tick) => tick + 1)
      }
    })
  }, [activeWorktreeId, submodulePathsKey])

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !submodulePathsKey) {
      return
    }
    const target = getWorktreeGitOwnerTarget(activeWorktreeId)
    if (!target) {
      return
    }
    let canceled = false
    const context = {
      target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: getConnectionId(activeWorktreeId) ?? undefined
    }
    // Skipping in-flight reads keeps slow hosts from stacking a new read per parent refresh.
    const queue = submodulePathsKey
      .split('\0')
      .filter((path) => !inFlight.current.has(`${scopeKey}\0${path}`))
    const runNext = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined && !canceled; path = queue.shift()) {
        const submodulePath = path
        const childEntries = await readSubmoduleChildEntries(
          context,
          submodulePath,
          inFlight.current,
          `${scopeKey}\0${submodulePath}`
        )
        if (childEntries) {
          setResult((prev) =>
            prev.scopeKey !== scopeKey
              ? prev
              : {
                  scopeKey,
                  entriesByPath: { ...prev.entriesByPath, [submodulePath]: childEntries }
                }
          )
        }
      }
    }
    for (let i = 0; i < Math.min(SUBMODULE_STATUS_CONCURRENCY, queue.length); i++) {
      void runNext()
    }
    return () => {
      canceled = true
    }
  }, [activeWorktreeId, parentReadTick, scopeKey, submodulePathsKey, worktreePath])

  return useMemo(() => {
    if (!submodulePathsKey || result.scopeKey !== scopeKey) {
      return NO_ENTRIES
    }
    const merged: GitStatusEntry[] = []
    for (const submodulePath of submodulePathsKey.split('\0')) {
      const childEntries = result.entriesByPath[submodulePath]
      if (childEntries) {
        merged.push(...childEntries)
      }
    }
    return merged.length > 0 ? merged : NO_ENTRIES
  }, [result, scopeKey, submodulePathsKey])
}

type FileExplorerGitDecorationInput = Parameters<typeof useFileExplorerSubmoduleStatus>[0]

/** Explorer badge maps from parent status plus inner status of expanded dirty submodules. */
export function useFileExplorerGitDecorations(input: FileExplorerGitDecorationInput): {
  statusByRelativePath: ReturnType<typeof buildStatusMap>
  folderStatusByRelativePath: ReturnType<typeof buildFolderStatusMap>
} {
  const { entries } = input
  const submoduleEntries = useFileExplorerSubmoduleStatus(input)
  return useMemo(() => {
    const decorationEntries =
      submoduleEntries.length > 0 ? [...entries, ...submoduleEntries] : [...entries]
    return {
      statusByRelativePath: buildStatusMap(decorationEntries),
      folderStatusByRelativePath: buildFolderStatusMap(decorationEntries)
    }
  }, [entries, submoduleEntries])
}
