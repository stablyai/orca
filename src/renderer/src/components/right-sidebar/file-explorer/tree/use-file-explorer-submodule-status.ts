import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { onGitStatusRead } from '@/store/slices/editor/git/git-status-read-signal'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getRelativePathInsideRoot } from '@/lib/path'
import { getRuntimeGitSubmoduleStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { useWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'
import { buildSubmoduleChildEntry } from '../../source-control/listing/submodule-expansion'
import { useSubmoduleWorkingStatusSupport } from './file-explorer-submodule-capability'
import { SubmoduleStatusReadQueue } from './file-explorer-submodule-read-queue'
import { areGitStatusEntriesEqual } from '@/store/slices/editor/git/git-status-reconciliation'
import {
  buildFolderStatusMap,
  buildStatusMap
} from '../../../../lib/source-control/paths/git-path-decoration'

// Why: bounds parallel `git status` processes (and SSH round trips) across all refreshes.
const SUBMODULE_STATUS_CONCURRENCY = 4

const NO_ENTRIES: GitStatusEntry[] = []
const EMPTY_ENTRIES_BY_PATH: ReadonlyMap<string, GitStatusEntry[]> = new Map()

/** Discover expanded dirty submodules one level at a time through already-loaded parent submodule entries. */
function selectExpandedDirtySubmodulePaths(
  rootEntries: readonly GitStatusEntry[],
  entriesByPath: ReadonlyMap<string, GitStatusEntry[]>,
  expandedRelativePaths: ReadonlySet<string>,
  includeMovedSubmodules: boolean
): string[] {
  const discovered: string[] = []
  const seen = new Set<string>()
  let frontier: readonly GitStatusEntry[] = rootEntries

  while (frontier.length > 0) {
    const levelPaths = new Set<string>()
    for (const entry of frontier) {
      const submodule = entry.submodule
      if (!submodule || entry.area === 'staged') {
        continue
      }
      if (!submodule.trackedChanges && !submodule.untrackedChanges) {
        continue
      }
      if (!includeMovedSubmodules && submodule.commitChanged) {
        continue
      }
      const path = normalizeRelativePath(entry.path)
      if (expandedRelativePaths.has(path) && !seen.has(path)) {
        levelPaths.add(path)
      }
    }
    if (levelPaths.size === 0) {
      break
    }
    // Path order roughly follows the explorer's top-to-bottom rows within each nesting level.
    const sortedLevel = Array.from(levelPaths).sort()
    const nextFrontier: GitStatusEntry[] = []
    for (const path of sortedLevel) {
      seen.add(path)
      discovered.push(path)
      const cachedChildren = entriesByPath.get(path)
      if (cachedChildren) {
        nextFrontier.push(...cachedChildren)
      }
    }
    frontier = nextFrontier
  }

  return discovered
}

/** Parent-relative inner entries, or null on failure so callers keep the last good badges. */
async function readSubmoduleChildEntries(
  context: Parameters<typeof getRuntimeGitSubmoduleStatus>[0],
  submodulePath: string,
  workingTreeOnly: boolean
): Promise<GitStatusEntry[] | null> {
  try {
    const status = await getRuntimeGitSubmoduleStatus(
      context,
      submodulePath,
      'unstaged',
      workingTreeOnly ? { workingTreeOnly: true } : undefined
    )
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
  // Reactive so a host or connection switch clears prior badges and re-arms reads.
  const ownerTarget = useWorktreeGitOwnerTarget(activeWorktreeId)
  const connectionId = useAppStore((s) => getConnectionIdFromState(s, activeWorktreeId))
  const runtimeRouteKey = ownerTarget?.kind === 'environment' ? ownerTarget.environmentId : ''
  const scopeKey = `${connectionId ?? ''}\0${runtimeRouteKey}\0${activeWorktreeId ?? ''}\0${worktreePath ?? ''}`

  const [result, setResult] = useState<SubmoduleStatusResult>(() => ({
    scopeKey,
    entriesByPath: new Map()
  }))
  // Reset during render so a host/connection/worktree switch cannot paint the previous route's badges.
  if (result.scopeKey !== scopeKey) {
    setResult({ scopeKey, entriesByPath: new Map() })
  }
  const [queue] = useState(() => new SubmoduleStatusReadQueue(SUBMODULE_STATUS_CONCURRENCY))
  useEffect(() => () => queue.setWanted('', [], null), [queue])

  const workingStatusSupport = useSubmoduleWorkingStatusSupport(readsEnabled ? ownerTarget : null)
  const workingTreeOnly = workingStatusSupport === 'supported'

  const scopedEntriesByPath =
    result.scopeKey === scopeKey ? result.entriesByPath : EMPTY_ENTRIES_BY_PATH
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
    return selectExpandedDirtySubmodulePaths(
      entries,
      scopedEntriesByPath,
      expandedRelativePaths,
      workingTreeOnly
    ).join('\0')
  }, [entries, expanded, scopedEntriesByPath, workingTreeOnly, worktreePath])

  useEffect(() => {
    const target =
      readsEnabled && submodulePathsKey && workingStatusSupport !== 'pending' ? ownerTarget : null
    if (!activeWorktreeId || !worktreePath || !target || connectionId === undefined) {
      queue.setWanted(scopeKey, [], null)
      return
    }
    const context = {
      target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: connectionId ?? undefined
    }
    queue.setWanted(scopeKey, submodulePathsKey.split('\0'), {
      read: (submodulePath) => readSubmoduleChildEntries(context, submodulePath, workingTreeOnly),
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
    // A second edit inside an already-dirty submodule leaves parent status identical, so follow every parent read.
    const unsubscribe = onGitStatusRead((worktreeId) => {
      if (worktreeId === activeWorktreeId) {
        queue.requestAll()
      }
    })
    return unsubscribe
  }, [
    activeWorktreeId,
    connectionId,
    ownerTarget,
    queue,
    readsEnabled,
    scopeKey,
    submodulePathsKey,
    workingStatusSupport,
    workingTreeOnly,
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
