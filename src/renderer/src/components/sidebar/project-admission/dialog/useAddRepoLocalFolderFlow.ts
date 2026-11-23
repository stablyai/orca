import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/diagnostics/telemetry/telemetry'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import {
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId
} from '../../../../../../shared/telemetry/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { WorktreeFetchOptions } from '@/store/slices/worktrees/listing/worktree-fetch-options'
import type { RepoSlice } from '@/store/repos/repo-state'
import type { AppState } from '@/store/types'
import type { ShowNestedRepoReviewArgs } from '../nested-import/useAddRepoNestedReviewState'
import { createNestedRepoScanId } from './add-repo-dialog-types'
import { confirmNonGitFolderAdd, needsFolderConfirmation } from './non-git-folder-confirmation'
import { translate } from '@/i18n/i18n'
import { worktreeRefreshOptions } from '../host-selection/add-repo-runtime-owner'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { addRepoBusyLabels } from './add-repo-busy-labels'
import {
  addLocalPathsForGeneration,
  heldByWslHostOffer,
  useDroppedLocalPathAutoAdd,
  usePickedLocalPathsAutoAdd,
  type LocalPathAddMode,
  type LocalPathAddResult,
  type PausedLocalPathAdd,
  type OfferWslHost
} from './add-repo-local-path-batch'

export function useAddRepoLocalFolderFlow({
  isOpen,
  droppedLocalPath,
  pickedLocalPaths = null,
  onPickedPathsUnsettled,
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
  isOpen: boolean
  droppedLocalPath: string
  pickedLocalPaths?: readonly string[] | null
  /** Close a suppressed start dialog when pre-picked paths finish without opening nested review or another modal. */
  onPickedPathsUnsettled?: () => void
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
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setAddProjectBusyLabel: (label: string | null) => void
  /** True when it held this single local path to offer running its WSL distro as a host. */
  offerWslHost?: OfferWslHost
}): {
  handleBrowse: () => Promise<void>
  resetLocalFolderFlow: () => void
  handleAddLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
} {
  const localAddGenRef = useRef(0)
  const droppedLocalPathHandledRef = useRef<string | null>(null)
  const pickedLocalPathsHandledRef = useRef<readonly string[] | null>(null)

  const resetLocalFolderFlow = useCallback((): void => {
    localAddGenRef.current++
    droppedLocalPathHandledRef.current = null
    pickedLocalPathsHandledRef.current = null
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
          // Review actions stay disabled until this final show, so it is the one that reports.
          const projectAdded = new Promise<PausedLocalPathAdd | null>((reportProject) => {
            showNestedRepoReview({
              scan,
              selectedPath: path,
              connectionId: null,
              attemptId,
              runtimeKind: 'local',
              inProgress: false,
              scanId,
              runtimeEnvironmentId: activeRuntimeEnvironmentId,
              reportProject
            })
          })
          return { status: 'paused', projectAdded }
        }
        if (needsFolderConfirmation(scan, mode)) {
          closeModal()
          const folder = confirmNonGitFolderAdd(openModal, path, scan)
          return { status: 'paused', projectAdded: folder.then((repo) => (repo ? { repo } : null)) }
        }
        setAddProjectBusyLabel(addRepoBusyLabels.openingProject())
        const repo = await addRepoPath(path, undefined, {
          runtimeEnvironmentId: activeRuntimeEnvironmentId ?? null
        })
        if (gen !== localAddGenRef.current) {
          return { status: 'cancelled' }
        }
        if (!repo) {
          return { status: 'failed' }
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
    (paths: readonly string[], source: AddRepoExistingWorkspaceSource, gen: number) =>
      addLocalPathsForGeneration({
        paths,
        source,
        gen,
        isCurrentGen: () => gen === localAddGenRef.current,
        activeRuntimeEnvironmentId,
        addLocalPathForGeneration,
        onGitRepoReady
      }),
    [activeRuntimeEnvironmentId, addLocalPathForGeneration, onGitRepoReady]
  )

  useDroppedLocalPathAutoAdd({
    isOpen,
    droppedLocalPath,
    droppedLocalPathHandledRef,
    localAddGenRef,
    offerWslHost,
    addPath: handleAddLocalPath
  })

  const finishAddAttempt = useCallback((): void => {
    clearNestedScanState()
    setIsAdding(false)
    setAddProjectBusyLabel(null)
  }, [clearNestedScanState, setAddProjectBusyLabel, setIsAdding])

  usePickedLocalPathsAutoAdd({
    isOpen,
    pickedLocalPaths,
    pickedLocalPathsHandledRef,
    localAddGenRef,
    offerWslHost,
    addPaths: handleAddLocalPaths,
    onUnsettled: onPickedPathsUnsettled,
    setIsAdding,
    onFinishAttempt: finishAddAttempt
  })

  const handleBrowse = useCallback(async (): Promise<void> => {
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    setAddProjectBusyLabel(addRepoBusyLabels.chooseFolder())
    try {
      const paths = await window.api.repos.pickFolders()
      if (paths.length === 0 || gen !== localAddGenRef.current) {
        return
      }
      const isCurrent = (): boolean => gen === localAddGenRef.current
      if (
        paths.length === 1
          ? await heldByWslHostOffer(offerWslHost, paths[0], isCurrent)
          : !isCurrent()
      ) {
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
  }, [clearNestedScanState, handleAddLocalPaths, offerWslHost, setAddProjectBusyLabel, setIsAdding])

  return { handleBrowse, resetLocalFolderFlow, handleAddLocalPath }
}
