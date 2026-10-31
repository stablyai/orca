import type { GitRepoAddOutcome } from './use-complete-git-repo-add'
import { beginDesktopNavigation, type DesktopNavigationRequest } from '@/lib/desktop-navigation'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId
} from '../../../../shared/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import type { RepoSlice } from '@/store/repos/repo-state'
import type { AppState } from '@/store/types'
import type { ShowNestedRepoReviewArgs } from './useAddRepoNestedReviewState'
import { createNestedRepoScanId } from './add-repo-dialog-types'
import { translate } from '@/i18n/i18n'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { addRepoBusyLabels } from './add-repo-busy-labels'
import {
  addLocalProjectPaths,
  type LocalPathAddResult,
  type LocalPathAddMode
} from './add-repo-local-path-batch'

export function useAddRepoLocalFolderFlow({
  navigation,
  isOpen,
  droppedLocalPath,
  activeRuntimeEnvironmentId,
  addRepoPath,
  openModal,
  closeModal,
  fetchWorktrees,
  scanNestedRepos,
  setActiveNestedScanId,
  setNestedScanInProgress,
  showNestedRepoReview,
  onGitRepoReady,
  setIsAdding,
  setAddProjectBusyLabel,
  offerWslHost
}: {
  navigation?: DesktopNavigationRequest
  isOpen: boolean
  droppedLocalPath: string
  activeRuntimeEnvironmentId: string | null | undefined
  addRepoPath: RepoSlice['addRepoPath']
  openModal: AppState['openModal']
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  scanNestedRepos: RepoSlice['scanNestedRepos']
  setActiveNestedScanId: (scanId: string | null, runtimeEnvironmentId?: string | null) => void
  setNestedScanInProgress: (inProgress: boolean) => void
  showNestedRepoReview: (args: ShowNestedRepoReviewArgs) => void
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId,
    outcome?: GitRepoAddOutcome
  ) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setAddProjectBusyLabel: (label: string | null) => void
  /** True when it held this single local path to offer running its WSL distro as a host. */
  offerWslHost?: (path: string, source: AddRepoExistingWorkspaceSource) => boolean
}): {
  handleBrowse: () => Promise<void>
  resetLocalFolderFlow: () => void
  handleAddLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
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
      mode: LocalPathAddMode = 'single',
      request: DesktopNavigationRequest = navigation ?? beginDesktopNavigation()
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
      setAddProjectBusyLabel(addRepoBusyLabels.scanningRepositories())
      try {
        const attemptId = createNestedRepoTelemetryAttemptId()
        const scanId = createNestedRepoScanId()
        setActiveNestedScanId(scanId, activeRuntimeEnvironmentId ?? null)
        setNestedScanInProgress(true)
        const scan = await scanNestedRepos(path, undefined, {
          scanId,
          runtimeEnvironmentId: activeRuntimeEnvironmentId ?? null,
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
        if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
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
        if (scan?.selectedPathKind === 'non_git_folder') {
          closeModal()
          openModal('confirm-non-git-folder', { folderPath: path, navigation: request })
          return { status: 'paused' }
        }
        setAddProjectBusyLabel(addRepoBusyLabels.openingProject())
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
          await onGitRepoReady(repo.id, source, ownerOptions.executionHostId, {
            navigation: request
          })
        } else {
          // Folder projects activate their synthetic root through the add flow instead of Git checkout completion.
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
      navigation,
      activeRuntimeEnvironmentId,
      addRepoPath,
      clearNestedScanState,
      closeModal,
      fetchWorktrees,
      onGitRepoReady,
      openModal,
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
        return await addLocalPathForGeneration(
          path,
          source,
          gen,
          mode,
          navigation ?? beginDesktopNavigation()
        )
      } finally {
        if (gen === localAddGenRef.current) {
          clearNestedScanState()
          setIsAdding(false)
          setAddProjectBusyLabel(null)
        }
      }
    },
    [
      navigation,
      addLocalPathForGeneration,
      clearNestedScanState,
      setAddProjectBusyLabel,
      setIsAdding
    ]
  )

  useEffect(() => {
    if (!isOpen || !droppedLocalPath) {
      return
    }
    if (droppedLocalPathHandledRef.current === droppedLocalPath) {
      return
    }
    droppedLocalPathHandledRef.current = droppedLocalPath
    if (!offerWslHost?.(droppedLocalPath, 'local_folder_picker')) {
      void handleAddLocalPath(droppedLocalPath, 'local_folder_picker')
    }
  }, [droppedLocalPath, handleAddLocalPath, isOpen, offerWslHost])

  const handleBrowse = useCallback(async (): Promise<void> => {
    const request = navigation ?? beginDesktopNavigation()
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    setAddProjectBusyLabel(addRepoBusyLabels.chooseFolder())
    try {
      const paths = await window.api.repos.pickFolders()
      if (paths.length === 0 || gen !== localAddGenRef.current) {
        return
      }
      if (paths.length === 1 && offerWslHost?.(paths[0], 'local_folder_picker')) {
        return
      }
      await addLocalProjectPaths(
        paths,
        (path, mode) => addLocalPathForGeneration(path, 'local_folder_picker', gen, mode, request),
        () => gen === localAddGenRef.current,
        (repoId) =>
          onGitRepoReady(
            repoId,
            'local_folder_picker',
            worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null).executionHostId,
            { navigation: request }
          )
      )
    } finally {
      if (gen === localAddGenRef.current) {
        clearNestedScanState()
        setIsAdding(false)
        setAddProjectBusyLabel(null)
      }
    }
  }, [
    navigation,
    clearNestedScanState,
    activeRuntimeEnvironmentId,
    addLocalPathForGeneration,
    onGitRepoReady,
    offerWslHost,
    setAddProjectBusyLabel,
    setIsAdding
  ])

  return { handleBrowse, resetLocalFolderFlow, handleAddLocalPath }
}
