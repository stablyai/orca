import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'
import type { GitStatusEntry, GitStatusResult } from '../../../../../../shared/git-status-types'
import {
  NESTED_REPO_SCAN_OPTIONS,
  folderPathIsInsideWorktree,
  listNestedRepoParentFolders,
  selectDefaultNestedRepo
} from './nested-folder-paths'

const folderPathByWorktree = new Map<string, string>()
const STATUS_CONCURRENCY = 4
const STATUS_POLL_MS = 5000

export type NestedRepoStatus = {
  repo: NestedRepoCandidate
  status: GitStatusResult | null
  error: string | null
}

export type NestedRepoTarget = {
  path: string
  entries: GitStatusEntry[]
  branch: string
  refresh: () => Promise<void>
  filterQuery?: string
}

export type NestedFolderScope = {
  folderPath: string | null
  repos: NestedRepoCandidate[]
  statuses: NestedRepoStatus[]
  selectedRepoPath: string | null
  scanning: boolean
  scanError: string | null
  gitTargetPath: string | null
  gitTargetEntries: GitStatusEntry[] | null
  gitTargetBranch: string | null
  setFolderPath: (path: string | null) => void
  selectRepo: (path: string) => void
  refreshAll: () => Promise<void>
  refreshStatuses: () => Promise<void>
  listRepoFolders: () => Promise<string[]>
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function readRepoStatus(
  repo: NestedRepoCandidate,
  connectionId: string | null
): Promise<NestedRepoStatus> {
  try {
    const status = await window.api.git.status({
      worktreePath: repo.path,
      ...(connectionId ? { connectionId } : {})
    })
    return { repo, status, error: null }
  } catch (error) {
    return {
      repo,
      status: null,
      error: error instanceof Error ? error.message : 'Failed to read git status'
    }
  }
}

export function useNestedFolderScope({
  worktreeId,
  worktreePath,
  connectionId
}: {
  worktreeId: string | null
  worktreePath: string | null
  connectionId: string | null
}): NestedFolderScope {
  const [folderPath, setFolderPathState] = useState<string | null>(() =>
    worktreeId ? (folderPathByWorktree.get(worktreeId) ?? null) : null
  )
  const [repos, setRepos] = useState<NestedRepoCandidate[]>([])
  const [statuses, setStatuses] = useState<NestedRepoStatus[]>([])
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  const statusEpoch = useRef(0)

  const [trackedWorktreeId, setTrackedWorktreeId] = useState(worktreeId)
  if (trackedWorktreeId !== worktreeId) {
    setTrackedWorktreeId(worktreeId)
    setFolderPathState(worktreeId ? (folderPathByWorktree.get(worktreeId) ?? null) : null)
    setRepos([])
    setStatuses([])
    setSelectedRepoPath(null)
    setScanError(null)
  }

  const setFolderPath = useCallback(
    (path: string | null) => {
      if (!worktreeId) {
        return
      }
      if (path && worktreePath && !folderPathIsInsideWorktree(worktreePath, path)) {
        setScanError(
          translate(
            'sourceControl.nestedFolder.outsideWorkspace',
            'Selected folder is outside this workspace'
          )
        )
        return
      }
      if (path) {
        folderPathByWorktree.set(worktreeId, path)
      } else {
        folderPathByWorktree.delete(worktreeId)
      }
      setFolderPathState(path)
      setSelectedRepoPath(null)
      setScanError(null)
    },
    [worktreeId, worktreePath]
  )

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!folderPath || !worktreePath) {
      setRepos([])
      setStatuses([])
      return
    }
    const generation = ++requestGeneration.current
    statusEpoch.current++
    setScanning(true)
    setScanError(null)
    try {
      const scan = await window.api.projectGroups.scanNested({
        path: folderPath,
        ...(connectionId ? { connectionId } : {}),
        options: { ...NESTED_REPO_SCAN_OPTIONS }
      })
      if (generation !== requestGeneration.current) {
        return
      }
      const discovered = scan.repos
      setRepos(discovered)
      const nextStatuses = await mapWithConcurrency(discovered, STATUS_CONCURRENCY, (repo) =>
        readRepoStatus(repo, connectionId)
      )
      if (generation !== requestGeneration.current) {
        return
      }
      setStatuses(nextStatuses)
      const changeCountByPath = new Map(
        nextStatuses.map((entry) => [entry.repo.path, entry.status?.entries.length ?? 0])
      )
      setSelectedRepoPath((current) => {
        if (current && discovered.some((repo) => repo.path === current)) {
          return current
        }
        return selectDefaultNestedRepo(discovered, changeCountByPath)
      })
    } catch (error) {
      if (generation !== requestGeneration.current) {
        return
      }
      setRepos([])
      setStatuses([])
      setScanError(error instanceof Error ? error.message : 'Failed to scan nested repositories')
    } finally {
      if (generation === requestGeneration.current) {
        setScanning(false)
      }
    }
  }, [connectionId, folderPath, worktreePath])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const reposRef = useRef(repos)
  reposRef.current = repos
  const refreshStatuses = useCallback(async (): Promise<void> => {
    if (reposRef.current.length === 0) {
      return
    }
    const scanGeneration = requestGeneration.current
    const epoch = ++statusEpoch.current
    try {
      const next = await mapWithConcurrency(reposRef.current, STATUS_CONCURRENCY, (repo) =>
        readRepoStatus(repo, connectionId)
      )
      if (scanGeneration === requestGeneration.current && epoch === statusEpoch.current) {
        setStatuses(next)
      }
    } catch {
      // Keep the last good statuses; the next poll or mutation retries.
    }
  }, [connectionId])
  // Repo list is stable between scans; re-read only status so terminal edits show up.
  useEffect(() => {
    if (!folderPath) {
      return
    }
    let polling = false
    const timer = window.setInterval(() => {
      if (polling || document.hidden || reposRef.current.length === 0) {
        return
      }
      polling = true
      void refreshStatuses().finally(() => {
        polling = false
      })
    }, STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [folderPath, refreshStatuses])

  // Folders directly containing repos, so the picker can offer them without a native dialog.
  const listRepoFolders = useCallback(async (): Promise<string[]> => {
    if (!worktreePath) {
      return []
    }
    const scan = await window.api.projectGroups.scanNested({
      path: worktreePath,
      ...(connectionId ? { connectionId } : {}),
      options: { ...NESTED_REPO_SCAN_OPTIONS }
    })
    return listNestedRepoParentFolders(
      scan.repos.map((repo) => repo.path),
      worktreePath
    )
  }, [connectionId, worktreePath])

  const selectedStatus = useMemo(
    () => statuses.find((entry) => entry.repo.path === selectedRepoPath) ?? null,
    [selectedRepoPath, statuses]
  )

  return {
    folderPath,
    repos,
    statuses,
    selectedRepoPath,
    scanning,
    scanError,
    gitTargetPath: selectedRepoPath,
    gitTargetEntries: selectedStatus?.status?.entries ?? (selectedRepoPath ? [] : null),
    gitTargetBranch: selectedStatus?.status?.branch ?? null,
    setFolderPath,
    selectRepo: setSelectedRepoPath,
    refreshAll,
    refreshStatuses,
    listRepoFolders
  }
}
