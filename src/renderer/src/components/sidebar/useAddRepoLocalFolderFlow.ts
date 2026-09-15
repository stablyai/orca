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
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import type { RepoSlice } from '@/store/repos/repo-state'
import { createNestedRepoScanId } from './add-repo-dialog-types'
import { translate } from '@/i18n/i18n'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { addLocalPathBatch } from './add-repo-local-batch'

type ShowNestedRepoReview = (args: {
  scan: NestedRepoScanResult
  selectedPath: string
  connectionId: string | null
  attemptId: string
  runtimeKind: NestedRepoTelemetryRuntimeKind
  inProgress: boolean
  scanId: string | null
  runtimeEnvironmentId?: string | null
}) => void

type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' }

type LocalPathAddMode = 'single' | 'batch' | 'group'

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
  addRepoPath: RepoSlice['addRepoPath']
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  scanNestedRepos: RepoSlice['scanNestedRepos']
  setActiveNestedScanId: (scanId: string | null, runtimeEnvironmentId?: string | null) => void
  setNestedScanInProgress: (inProgress: boolean) => void
  showNestedRepoReview: ShowNestedRepoReview
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setAddProjectBusyLabel: (label: string | null) => void
}): {
  handleBrowse: () => Promise<void>
  handleGroupRepositories: () => Promise<void>
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
        setActiveNestedScanId(scanId, activeRuntimeEnvironmentId ?? null)
        setNestedScanInProgress(true)
        const scan = await scanNestedRepos(path, undefined, {
          scanId,
          runtimeEnvironmentId: activeRuntimeEnvironmentId ?? null,
          traverseGitRoot: mode === 'group',
          onProgress: (progressScan) => {
            if (
              gen !== localAddGenRef.current ||
              mode === 'batch' ||
              (progressScan.selectedPathKind !== 'non_git_folder' && mode !== 'group') ||
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
              scanId,
              runtimeEnvironmentId: activeRuntimeEnvironmentId
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
        if (
          scan &&
          scan.repos.length > 0 &&
          mode !== 'batch' &&
          (scan.selectedPathKind === 'non_git_folder' || mode === 'group')
        ) {
          // Why: a single-folder decision point cannot queue competing batch review states.
          showNestedRepoReview({
            scan,
            selectedPath: path,
            connectionId: null,
            attemptId,
            runtimeKind: 'local',
            inProgress: false,
            scanId,
            runtimeEnvironmentId: activeRuntimeEnvironmentId
          })
          return { status: 'paused' }
        }
        setAddProjectBusyLabel('Opening project...')
        const repo = await addRepoPath(path, undefined, {
          runtimeEnvironmentId: activeRuntimeEnvironmentId ?? null
        })
        if (gen !== localAddGenRef.current) {
          return { status: 'cancelled' }
        }
        if (!repo) {
          return { status: 'paused' }
        }
        if (isGitRepoKind(repo)) {
          // Why: a transient non-authoritative refresh must not strand a persisted repo.
          const ownerOptions = worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null)
          await fetchWorktrees(repo.id, ownerOptions)
          if (gen !== localAddGenRef.current) {
            return { status: 'cancelled' }
          }
          if (mode === 'batch') {
            return { status: 'completed', repo }
          }
          await onGitRepoReady(repo.id, source, ownerOptions.executionHostId)
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
      await addLocalPathBatch({
        paths,
        source,
        generation: gen,
        isCurrentGeneration: () => gen === localAddGenRef.current,
        addPath: addLocalPathForGeneration,
        onGitRepoReady,
        executionHostId: worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null).executionHostId
      })
    },
    [activeRuntimeEnvironmentId, addLocalPathForGeneration, onGitRepoReady]
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

  const handleGroupRepositories = useCallback(async (): Promise<void> => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      await handleAddLocalPath(path, 'local_folder_picker', 'group')
    }
  }, [handleAddLocalPath])

  return { handleBrowse, handleGroupRepositories, resetLocalFolderFlow }
}
