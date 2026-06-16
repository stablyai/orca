import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import { createNestedRepoScanId } from './add-repo-dialog-types'
import { translate } from '@/i18n/i18n'

type ShowNestedRepoReview = (args: {
  scan: NestedRepoScanResult
  selectedPath: string
  connectionId: string | null
  attemptId: string
  runtimeKind: NestedRepoTelemetryRuntimeKind
  inProgress: boolean
  scanId: string | null
}) => void

type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' }

type LocalPathAddMode = 'single' | 'batch'

export function useAddRepoLocalFolderFlow({
  isOpen,
  droppedLocalPath,
  activeRuntimeEnvironmentId,
  addRepoPath,
  closeModal,
  fetchWorktrees,
  scanNestedRepos,
  setActiveNestedScanId,
  setNestedScanInProgress,
  showNestedRepoReview,
  onGitRepoReady,
  setIsAdding,
  setAddProjectBusyLabel
}: {
  isOpen: boolean
  droppedLocalPath: string
  activeRuntimeEnvironmentId: string | null | undefined
  addRepoPath: (path: string, kind?: 'git' | 'folder') => Promise<Repo | null>
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: { requireAuthoritative?: boolean }) => Promise<unknown>
  scanNestedRepos: (
    path: string,
    connectionId?: string,
    controls?: { scanId?: string; onProgress?: (scan: NestedRepoScanResult) => void }
  ) => Promise<NestedRepoScanResult | null>
  setActiveNestedScanId: (scanId: string | null) => void
  setNestedScanInProgress: (inProgress: boolean) => void
  showNestedRepoReview: ShowNestedRepoReview
  onGitRepoReady: (repoId: string, source: AddRepoExistingWorkspaceSource) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setAddProjectBusyLabel: (label: string | null) => void
}): {
  handleBrowse: () => Promise<void>
  resetLocalFolderFlow: () => void
} {
  const localAddGenRef = useRef(0)
  const droppedLocalPathHandledRef = useRef<string | null>(null)

  const resetLocalFolderFlow = useCallback((): void => {
    localAddGenRef.current++
    droppedLocalPathHandledRef.current = null
  }, [])

  const clearNestedScanState = useCallback((): void => {
    setNestedScanInProgress(false)
    setActiveNestedScanId(null)
  }, [setActiveNestedScanId, setNestedScanInProgress])

  const addLocalPathForGeneration = useCallback(
    async (
      path: string,
      source: AddRepoExistingWorkspaceSource,
      gen: number,
      mode: LocalPathAddMode = 'single'
    ): Promise<LocalPathAddResult> => {
      if (activeRuntimeEnvironmentId?.trim()) {
        toast.error(
          translate(
            'auto.components.sidebar.useAddRepoLocalFolderFlow.7ab10e4974',
            'Use a host path to add projects from a remote host.'
          )
        )
        closeModal()
        return { status: 'paused' }
      }
      setAddProjectBusyLabel('Scanning for repositories...')
      try {
        const attemptId = createNestedRepoTelemetryAttemptId()
        const scanId = createNestedRepoScanId()
        setActiveNestedScanId(scanId)
        setNestedScanInProgress(true)
        const scan = await scanNestedRepos(path, undefined, {
          scanId,
          onProgress: (progressScan) => {
            if (
              gen !== localAddGenRef.current ||
              mode === 'batch' ||
              progressScan.selectedPathKind !== 'non_git_folder' ||
              progressScan.repos.length === 0
            ) {
              return
            }
            showNestedRepoReview({
              scan: progressScan,
              selectedPath: path,
              connectionId: null,
              attemptId,
              runtimeKind: 'local',
              inProgress: true,
              scanId
            })
          }
        })
        if (gen !== localAddGenRef.current) {
          return { status: 'cancelled' }
        }
        clearNestedScanState()
        track(
          'add_repo_nested_scan_result',
          buildNestedRepoScanTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind: 'local',
            scan
          })
        )
        if (scan?.selectedPathKind === 'non_git_folder' && mode === 'batch') {
          return { status: 'skipped' }
        }
        if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
          // Why: the existing nested-repo review is a single-folder decision point.
          // Pause batch imports here instead of queueing competing review states.
          showNestedRepoReview({
            scan,
            selectedPath: path,
            connectionId: null,
            attemptId,
            runtimeKind: 'local',
            inProgress: false,
            scanId
          })
          return { status: 'paused' }
        }
        setAddProjectBusyLabel('Opening project...')
        const repo = await addRepoPath(path)
        if (gen !== localAddGenRef.current) {
          return { status: 'cancelled' }
        }
        if (!repo) {
          return { status: 'paused' }
        }
        if (isGitRepoKind(repo)) {
          // Why: once the repo exists, a transient non-authoritative refresh
          // should fall through to project reveal instead of leaving the add flow open.
          await fetchWorktrees(repo.id, { requireAuthoritative: true })
          if (gen !== localAddGenRef.current) {
            return { status: 'cancelled' }
          }
          if (mode === 'batch') {
            return { status: 'completed', repo }
          }
          await onGitRepoReady(repo.id, source)
        } else {
          // Why: folder repos skip the Git default-checkout handoff and activate
          // their synthetic root workspace in the folder add flow.
          closeModal()
        }
        return { status: 'completed', repo }
      } finally {
        if (gen === localAddGenRef.current) {
          clearNestedScanState()
        }
      }
    },
    [
      activeRuntimeEnvironmentId,
      addRepoPath,
      clearNestedScanState,
      closeModal,
      fetchWorktrees,
      onGitRepoReady,
      scanNestedRepos,
      setActiveNestedScanId,
      setAddProjectBusyLabel,
      setNestedScanInProgress,
      showNestedRepoReview
    ]
  )

  const handleAddLocalPath = useCallback(
    async (
      path: string,
      source: AddRepoExistingWorkspaceSource,
      mode: LocalPathAddMode = 'single'
    ): Promise<LocalPathAddResult> => {
      const gen = ++localAddGenRef.current
      setIsAdding(true)
      try {
        return await addLocalPathForGeneration(path, source, gen, mode)
      } finally {
        if (gen === localAddGenRef.current) {
          clearNestedScanState()
          setIsAdding(false)
          setAddProjectBusyLabel(null)
        }
      }
    },
    [addLocalPathForGeneration, clearNestedScanState, setAddProjectBusyLabel, setIsAdding]
  )

  const handleAddLocalPaths = useCallback(
    async (paths: string[], source: AddRepoExistingWorkspaceSource, gen: number): Promise<void> => {
      const gitRepoIds: string[] = []
      const shouldDeferGitRepoReady = paths.length > 1
      let skippedCount = 0
      for (const path of paths) {
        const result = await addLocalPathForGeneration(
          path,
          source,
          gen,
          shouldDeferGitRepoReady ? 'batch' : 'single'
        )
        if (result.status === 'skipped') {
          skippedCount++
          continue
        }
        if (result.status !== 'completed') {
          return
        }
        if (isGitRepoKind(result.repo)) {
          gitRepoIds.push(result.repo.id)
        }
      }
      if (gen !== localAddGenRef.current) {
        return
      }
      if (skippedCount > 0) {
        toast.info(
          translate(
            'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFolders',
            'Some folders were skipped'
          ),
          {
            description: translate(
              'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFoldersDescription',
              'Add skipped folders individually to review or confirm them.'
            )
          }
        )
      }
      if (shouldDeferGitRepoReady && gitRepoIds.length > 0) {
        await onGitRepoReady(gitRepoIds[0], source)
      }
    },
    [addLocalPathForGeneration, onGitRepoReady]
  )

  useEffect(() => {
    if (!isOpen || !droppedLocalPath) {
      return
    }
    if (droppedLocalPathHandledRef.current === droppedLocalPath) {
      return
    }
    droppedLocalPathHandledRef.current = droppedLocalPath
    void handleAddLocalPath(droppedLocalPath, 'local_folder_picker')
  }, [droppedLocalPath, handleAddLocalPath, isOpen])

  const handleBrowse = useCallback(async (): Promise<void> => {
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    setAddProjectBusyLabel('Choose a folder...')
    try {
      const paths = await window.api.repos.pickFolders()
      if (paths.length === 0 || gen !== localAddGenRef.current) {
        return
      }
      await handleAddLocalPaths(paths, 'local_folder_picker', gen)
    } finally {
      if (gen === localAddGenRef.current) {
        clearNestedScanState()
        setIsAdding(false)
        setAddProjectBusyLabel(null)
      }
    }
  }, [clearNestedScanState, handleAddLocalPaths, setAddProjectBusyLabel, setIsAdding])

  return { handleBrowse, resetLocalFolderFlow }
}
