import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { onGitStatusRead } from '@/store/slices/editor/git/git-status-read-signal'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getRuntimeGitSubmoduleStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { useWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'
import { buildSubmoduleChildEntry } from '../../source-control/listing/submodule-expansion'
import { SubmoduleStatusReadQueue } from './file-explorer-submodule-read-queue'
import { areGitStatusEntriesEqual } from '@/store/slices/editor/git/git-status-reconciliation'
import {
  buildFolderStatusMap,
  buildStatusMap
} from '../../../../../../shared/git/status/git-path-decoration'

// Why: bounds parallel `git status` processes (and SSH round trips) across all refreshes.
const SUBMODULE_STATUS_CONCURRENCY = 4
// Why: keeps inner reads near one parent read's cost (16 x 2k-file submodules, 4-wide ~= 1.3x) so huge expansions cannot run Git nonstop.
const FILE_EXPLORER_SUBMODULE_STATUS_LIMIT = 16

const NO_ENTRIES: GitStatusEntry[] = []

/** Dirty submodules the user has expanded; clean or collapsed ones never trigger inner Git work. */
function selectExpandedDirtySubmodulePaths(
  entries: readonly GitStatusEntry[],
  expandedRelativePaths: ReadonlySet<string>,
  limit: number = FILE_EXPLORER_SUBMODULE_STATUS_LIMIT
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
  // Path order roughly follows the explorer's top-to-bottom rows.
  return Array.from(paths).sort().slice(0, limit)
}

/** Parent-relative inner entries, or null on failure so callers keep the last good badges. */
async function readSubmoduleChildEntries(
  context: Parameters<typeof getRuntimeGitSubmoduleStatus>[0],
  submodulePath: string
): Promise<GitStatusEntry[] | null> {
  try {
    const status = await getRuntimeGitSubmoduleStatus(context, submodulePath)
    // A failed read resolves with empty entries, which must not look like a clean submodule.
    if (status.readError !== undefined) {
      return null
    }
    return status.entries.map((innerEntry) => buildSubmoduleChildEntry(submodulePath, innerEntry))
  } catch {
    return null
  }
}

type SubmoduleStatusResult = {
  scopeKey: string
  // A Map, since submodule paths like `constructor` would collide with Object.prototype keys.
  entriesByPath: ReadonlyMap<string, GitStatusEntry[]>
}

/** Parent-relative status entries for files inside expanded dirty submodules. */
function useFileExplorerSubmoduleStatus({
  activeWorktreeId,
  worktreePath,
  readsEnabled,
  entries,
  expanded
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  /** False while the Files view is hidden: reads pause, cached badges stay. */
  readsEnabled: boolean
  entries: readonly GitStatusEntry[]
  expanded: ReadonlySet<string>
}): GitStatusEntry[] {
  const scopeKey = `${activeWorktreeId ?? ''}\0${worktreePath ?? ''}`
  const [result, setResult] = useState<SubmoduleStatusResult>(() => ({
    scopeKey,
    entriesByPath: new Map()
  }))
  // Reset during render so a worktree switch cannot paint the previous one's badges.
  if (result.scopeKey !== scopeKey) {
    setResult({ scopeKey, entriesByPath: new Map() })
  }
  const [queue] = useState(() => new SubmoduleStatusReadQueue(SUBMODULE_STATUS_CONCURRENCY))

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

  // Reactive so a host that resolves later (e.g. SSH reconnect) re-arms reads and the parent-read listener.
  const ownerTarget = useWorktreeGitOwnerTarget(activeWorktreeId)

  useEffect(() => {
    const target = readsEnabled && submodulePathsKey ? ownerTarget : null
    if (!activeWorktreeId || !worktreePath || !target) {
      queue.setWanted([], null)
      return
    }
    const context = {
      target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: getConnectionId(activeWorktreeId) ?? undefined
    }
    queue.setWanted(submodulePathsKey.split('\0'), {
      read: (submodulePath) => readSubmoduleChildEntries(context, submodulePath),
      apply: (submodulePath, childEntries) =>
        setResult((prev) => {
          const cached = prev.entriesByPath.get(submodulePath)
          // Unchanged reads keep the same state so polls do not re-render the tree.
          if (
            prev.scopeKey !== scopeKey ||
            (cached && areGitStatusEntriesEqual(cached, childEntries))
          ) {
            return prev
          }
          return {
            scopeKey,
            entriesByPath: new Map(prev.entriesByPath).set(submodulePath, childEntries)
          }
        })
    })
    queue.requestAll()
    // A second edit inside an already-dirty submodule leaves parent status identical, so follow every parent read.
    const unsubscribe = onGitStatusRead((worktreeId) => {
      if (worktreeId === activeWorktreeId) {
        queue.requestAll()
      }
    })
    return () => {
      unsubscribe()
      queue.setWanted([], null)
    }
  }, [
    activeWorktreeId,
    ownerTarget,
    queue,
    readsEnabled,
    scopeKey,
    submodulePathsKey,
    worktreePath
  ])

  return useMemo(() => {
    if (!submodulePathsKey || result.scopeKey !== scopeKey) {
      return NO_ENTRIES
    }
    const merged: GitStatusEntry[] = []
    for (const submodulePath of submodulePathsKey.split('\0')) {
      const childEntries = result.entriesByPath.get(submodulePath)
      if (childEntries) {
        merged.push(...childEntries)
      }
    }
    return merged.length > 0 ? merged : NO_ENTRIES
  }, [result, scopeKey, submodulePathsKey])
}

// Why: a stable reference keeps the selector from re-rendering the pane when the active worktree has no status.
const NO_GIT_STATUS_ENTRIES: GitStatusEntry[] = []

/** Explorer badge maps from parent status plus inner status of expanded dirty submodules. */
export function useFileExplorerGitDecorations(
  input: Omit<Parameters<typeof useFileExplorerSubmoduleStatus>[0], 'entries'>
): {
  statusByRelativePath: ReturnType<typeof buildStatusMap>
  folderStatusByRelativePath: ReturnType<typeof buildFolderStatusMap>
} {
  const { activeWorktreeId } = input
  const entries = useAppStore((s) =>
    activeWorktreeId
      ? (s.gitStatusByWorktree[activeWorktreeId] ?? NO_GIT_STATUS_ENTRIES)
      : NO_GIT_STATUS_ENTRIES
  )
  const submoduleEntries = useFileExplorerSubmoduleStatus({ ...input, entries })
  return useMemo(() => {
    const decorationEntries =
      submoduleEntries.length > 0 ? [...entries, ...submoduleEntries] : entries
    return {
      statusByRelativePath: buildStatusMap(decorationEntries),
      folderStatusByRelativePath: buildFolderStatusMap(decorationEntries)
    }
  }, [entries, submoduleEntries])
}
