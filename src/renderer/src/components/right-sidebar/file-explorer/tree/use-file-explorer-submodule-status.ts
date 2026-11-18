import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { onGitStatusRead } from '@/store/slices/editor/git/git-status-read-signal'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getRelativePathInsideRoot } from '@/lib/path'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { getRuntimeGitSubmoduleWorkingTreeStatus } from '@/runtime/source-control/git/runtime-git-submodule-working-tree-client'
import { RuntimeCapabilityMissingError } from '@/runtime/repository-gitlab/runtime-gitlab-api'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { useWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'
import { buildSubmoduleChildEntry } from '../../source-control/listing/submodule-expansion'
import { SubmoduleStatusReadQueue } from './file-explorer-submodule-read-queue'
import { selectExpandedDirtySubmodules } from './file-explorer-submodule-selection'
import { areGitStatusEntriesEqual } from '@/store/slices/editor/git/git-status-reconciliation'
import {
  buildFolderStatusMap,
  buildStatusMap
} from '../../../../../../shared/git/status/git-path-decoration'

// Why: bounds parallel `git status` processes (and SSH round trips) across all refreshes.
const SUBMODULE_STATUS_CONCURRENCY = 4

const NO_ENTRIES: GitStatusEntry[] = []

/** Parent-relative inner entries, or null on failure so callers keep the last good badges. */
async function readSubmoduleChildEntries(
  context: RuntimeGitContext,
  submodulePath: string
): Promise<GitStatusEntry[] | null> {
  try {
    const status = await getRuntimeGitSubmoduleWorkingTreeStatus(context, submodulePath)
    // A failed read resolves with empty entries, which must not look like a clean submodule.
    return status.readError === undefined
      ? status.entries.map((innerEntry) => buildSubmoduleChildEntry(submodulePath, innerEntry))
      : null
  } catch (error) {
    // Older hosts would mix committed-range rows into the answer, so they get no inner badges.
    return error instanceof RuntimeCapabilityMissingError ? [] : null
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
  // Reactive so a host that resolves later (e.g. SSH reconnect) re-arms reads and the parent-read listener.
  const ownerTarget = useWorktreeGitOwnerTarget(activeWorktreeId)
  const connectionId = useAppStore((s) => getConnectionIdFromState(s, activeWorktreeId))
  const runtimeRouteKey = ownerTarget?.kind === 'environment' ? ownerTarget.environmentId : ''
  // Same owner route as Source Control's submodule rows, so a host switch or reconnect drops old badges.
  const scopeKey = `${connectionId ?? ''}\0${runtimeRouteKey}\0${activeWorktreeId ?? ''}\0${worktreePath ?? ''}`
  const [result, setResult] = useState<SubmoduleStatusResult>(() => ({
    scopeKey,
    entriesByPath: new Map()
  }))
  // Reset during render so a worktree switch cannot paint the previous one's badges.
  if (result.scopeKey !== scopeKey) {
    setResult({ scopeKey, entriesByPath: new Map() })
  }
  const [queue] = useState(() => new SubmoduleStatusReadQueue(SUBMODULE_STATUS_CONCURRENCY))
  const childEntriesByPath = result.scopeKey === scopeKey ? result.entriesByPath : null

  const selectionKey = useMemo(() => {
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
    return selectExpandedDirtySubmodules(
      entries,
      expandedRelativePaths,
      childEntriesByPath ?? new Map()
    ).join('\0')
  }, [childEntriesByPath, entries, expanded, worktreePath])

  useEffect(() => {
    const target = readsEnabled && selectionKey ? ownerTarget : null
    if (!activeWorktreeId || !worktreePath || !target) {
      queue.setWanted([], null)
      return
    }
    const context = {
      target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: connectionId ?? undefined
    }
    // In-flight and queued reads are keyed by the owner route as well as the path.
    const submodulePathByKey = new Map(
      selectionKey
        .split('\0')
        .map((submodulePath) => [`${scopeKey}\0${submodulePath}`, submodulePath])
    )
    queue.setWanted([...submodulePathByKey.keys()], {
      read: (key) => {
        const submodulePath = submodulePathByKey.get(key)
        return submodulePath === undefined
          ? Promise.resolve(null)
          : readSubmoduleChildEntries(context, submodulePath)
      },
      apply: (key, childEntries) => {
        const submodulePath = submodulePathByKey.get(key)
        if (submodulePath === undefined) {
          return
        }
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
      }
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
    connectionId,
    ownerTarget,
    queue,
    readsEnabled,
    scopeKey,
    selectionKey,
    worktreePath
  ])

  return useMemo(() => {
    if (!childEntriesByPath) {
      return NO_ENTRIES
    }
    const merged: GitStatusEntry[] = []
    for (const path of selectionKey ? selectionKey.split('\0') : []) {
      const childEntries = childEntriesByPath.get(path)
      if (childEntries) {
        merged.push(...childEntries)
      }
    }
    return merged.length > 0 ? merged : NO_ENTRIES
  }, [childEntriesByPath, selectionKey])
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
