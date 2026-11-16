import { useEffect, useMemo, useState } from 'react'
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

// Why: each expanded dirty submodule costs one `git status` per parent refresh.
export const FILE_EXPLORER_SUBMODULE_STATUS_LIMIT = 8

const NO_ENTRIES: GitStatusEntry[] = []

/** Dirty submodules the user has expanded; clean or collapsed ones never trigger inner Git work. */
export function selectExpandedDirtySubmodulePaths(
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
  return Array.from(paths).sort().slice(0, limit)
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
    for (const submodulePath of submodulePathsKey.split('\0')) {
      void getRuntimeGitSubmoduleStatus(context, submodulePath)
        .then((status) => {
          if (canceled) {
            return
          }
          const childEntries = status.entries.map((innerEntry) =>
            buildSubmoduleChildEntry(submodulePath, innerEntry)
          )
          setResult((prev) =>
            prev.scopeKey !== scopeKey
              ? prev
              : {
                  scopeKey,
                  entriesByPath: { ...prev.entriesByPath, [submodulePath]: childEntries }
                }
          )
        })
        // Keep the last good badges; a transient remote failure must not look like a clean submodule.
        .catch(() => {})
    }
    return () => {
      canceled = true
    }
    // `entries` changes on every parent status refresh, which is when inner status may have moved.
  }, [activeWorktreeId, entries, scopeKey, submodulePathsKey, worktreePath])

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
