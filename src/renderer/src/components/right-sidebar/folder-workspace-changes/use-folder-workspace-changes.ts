import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import { shouldRefreshGitStatusForFileChange } from '../git-status-file-watch-refresh'
import {
  isNestedRepoScanIncomplete,
  selectChangedRepos,
  selectImmediateChildRepos,
  type FolderWorkspaceChangedRepo,
  type FolderWorkspaceFailedRepo,
  type FolderWorkspaceRepoCandidate,
  type FolderWorkspaceRepoStatusOutcome
} from './changed-repo-model'
import { runLimitedRepoStatusRefreshes } from './changed-repos-refresh'

/** Watchers deliver atomic saves as bursts; one status fan-out per burst is enough. */
export const FOLDER_WORKSPACE_CHANGES_WATCH_DEBOUNCE_MS = 500
const STATUS_CONCURRENCY = 4
const IMMEDIATE_CHILD_SCAN_OPTIONS = { maxDepth: 1, maxRepos: 500 }

export type FolderWorkspaceChangesScanState = 'idle' | 'scanning' | 'ready' | 'error'

function isWorktreeFileChangeEvent(
  event: Event
): event is CustomEvent<WorktreeFileChangeEventDetail> {
  return event instanceof CustomEvent && event.detail !== null && event.detail !== undefined
}

export type FolderWorkspaceChangesData = {
  candidates: FolderWorkspaceRepoCandidate[]
  changedRepos: FolderWorkspaceChangedRepo[]
  failedRepos: FolderWorkspaceFailedRepo[]
  scanState: FolderWorkspaceChangesScanState
  /** Set to the repo cap when the scan ended early, so `candidates` may miss repos. Null when complete. */
  incompleteScanRepoCap: number | null
  isLoading: boolean
  refresh: () => void
  refreshStatuses: () => void
}

type UseFolderWorkspaceChangesArgs = {
  worktreeId: string | null
  folderWorkspaceId: string | null
  folderPath: string | null
  /** `undefined` means the folder's host cannot be determined (see getFolderWorkspaceConnectionId). */
  connectionId: string | null | undefined
  isVisible: boolean
}

export function useFolderWorkspaceChanges({
  worktreeId,
  folderWorkspaceId,
  folderPath,
  connectionId,
  isVisible
}: UseFolderWorkspaceChangesArgs): FolderWorkspaceChangesData {
  const settings = useAppStore((s) => s.settings)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  // Why: route scan and status by the folder's owner, not the globally focused runtime. Local and
  // SSH folders resolve to `null`, which pins the local IPC path even while a runtime is focused.
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, worktreeId)
  )
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const [candidates, setCandidates] = useState<FolderWorkspaceRepoCandidate[]>([])
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, FolderWorkspaceRepoStatusOutcome>>(
    () => new Map()
  )
  const [scanState, setScanState] = useState<FolderWorkspaceChangesScanState>('idle')
  const [incompleteScanRepoCap, setIncompleteScanRepoCap] = useState<number | null>(null)
  const [scanGeneration, setScanGeneration] = useState(0)
  const [statusGeneration, setStatusGeneration] = useState(0)

  // Why: reset during render so a workspace switch never paints the previous folder's repos.
  const [scopedFolderWorkspaceId, setScopedFolderWorkspaceId] = useState(folderWorkspaceId)
  if (scopedFolderWorkspaceId !== folderWorkspaceId) {
    setScopedFolderWorkspaceId(folderWorkspaceId)
    setCandidates([])
    setOutcomes(new Map())
    setScanState('idle')
    setIncompleteScanRepoCap(null)
  }

  const canRun =
    isVisible && folderWorkspaceId !== null && folderPath !== null && connectionId !== undefined

  useEffect(() => {
    if (!canRun || !folderPath) {
      return
    }
    let cancelled = false
    setScanState('scanning')
    void scanNestedRepos(folderPath, connectionId ?? undefined, {
      options: IMMEDIATE_CHILD_SCAN_OPTIONS,
      runtimeEnvironmentId: activeRuntimeEnvironmentId
    }).then((result) => {
      if (cancelled) {
        return
      }
      if (!result) {
        setScanState('error')
        return
      }
      setCandidates(selectImmediateChildRepos(result, folderPath))
      setIncompleteScanRepoCap(isNestedRepoScanIncomplete(result) ? result.maxRepos : null)
      setScanState('ready')
    })
    return () => {
      cancelled = true
    }
  }, [activeRuntimeEnvironmentId, canRun, connectionId, folderPath, scanGeneration, scanNestedRepos])

  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates
  const candidatesSignature = useMemo(
    () => candidates.map((candidate) => candidate.path).join('\0'),
    [candidates]
  )

  useEffect(() => {
    const current = candidatesRef.current
    setOutcomes((previous) => {
      const known = new Set(current.map((candidate) => candidate.path))
      const next = new Map([...previous].filter(([path]) => known.has(path)))
      return next.size === previous.size ? previous : next
    })
    if (!canRun || current.length === 0) {
      return
    }
    const controller = new AbortController()
    void runLimitedRepoStatusRefreshes({
      candidates: current,
      concurrency: STATUS_CONCURRENCY,
      signal: controller.signal,
      fetchStatus: (candidate, signal) =>
        getRuntimeGitStatus(
          {
            settings: settingsForRuntimeOwner(settingsRef.current, activeRuntimeEnvironmentId),
            worktreeId: null,
            worktreePath: candidate.path,
            connectionId: connectionId ?? undefined
          },
          { admissionTier: 'status', includeLineStats: false, signal }
        ),
      onOutcome: (repoPath, outcome) => {
        setOutcomes((previous) => new Map(previous).set(repoPath, outcome))
      }
    })
    return () => {
      controller.abort()
    }
  }, [activeRuntimeEnvironmentId, canRun, candidatesSignature, connectionId, statusGeneration])

  useEffect(() => {
    if (!canRun || !folderPath) {
      return
    }
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = (): void => {
      if (!isWindowVisible()) {
        return
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        if (isWindowVisible()) {
          setStatusGeneration((generation) => generation + 1)
        }
      }, FOLDER_WORKSPACE_CHANGES_WATCH_DEBOUNCE_MS)
    }
    const handleFsChanged = (event: Event): void => {
      if (!isWorktreeFileChangeEvent(event)) {
        return
      }
      const { detail } = event
      if ((detail.runtimeEnvironmentId ?? null) !== (activeRuntimeEnvironmentId ?? null)) {
        return
      }
      if (shouldRefreshGitStatusForFileChange(detail.payload, folderPath)) {
        scheduleRefresh()
      }
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFsChanged)
    return () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleFsChanged)
    }
  }, [activeRuntimeEnvironmentId, canRun, folderPath])

  const refresh = useCallback((): void => {
    setScanGeneration((generation) => generation + 1)
    setStatusGeneration((generation) => generation + 1)
  }, [])
  const refreshStatuses = useCallback((): void => {
    setStatusGeneration((generation) => generation + 1)
  }, [])

  const { changed, failed } = useMemo(
    () => selectChangedRepos(candidates, outcomes),
    [candidates, outcomes]
  )
  const isLoading =
    scanState === 'scanning' ||
    candidates.some((candidate) => (outcomes.get(candidate.path)?.kind ?? 'loading') === 'loading')

  return {
    candidates,
    changedRepos: changed,
    failedRepos: failed,
    scanState,
    incompleteScanRepoCap,
    isLoading,
    refresh,
    refreshStatuses
  }
}
