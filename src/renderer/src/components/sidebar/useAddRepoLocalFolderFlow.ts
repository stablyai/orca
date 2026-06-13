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

  const handleAddLocalPath = useCallback(
    async (path: string, source: AddRepoExistingWorkspaceSource): Promise<void> => {
      if (activeRuntimeEnvironmentId?.trim()) {
        toast.error(
          translate(
            'auto.components.sidebar.useAddRepoLocalFolderFlow.7ab10e4974',
            'Use a server path to add projects from a remote runtime.'
          )
        )
        closeModal()
        return
      }
      const gen = ++localAddGenRef.current
      setIsAdding(true)
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
          return
        }
        setNestedScanInProgress(false)
        setActiveNestedScanId(null)
        track(
          'add_repo_nested_scan_result',
          buildNestedRepoScanTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind: 'local',
            scan
          })
        )
        if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
          showNestedRepoReview({
            scan,
            selectedPath: path,
            connectionId: null,
            attemptId,
            runtimeKind: 'local',
            inProgress: false,
            scanId
          })
          return
        }
        setAddProjectBusyLabel('Opening project...')
        const repo = await addRepoPath(path)
        if (gen !== localAddGenRef.current) {
          return
        }
        if (repo && isGitRepoKind(repo)) {
          // Why: once the repo exists, a transient non-authoritative refresh
          // should fall through to project reveal instead of leaving the add flow open.
          await fetchWorktrees(repo.id, { requireAuthoritative: true })
          if (gen !== localAddGenRef.current) {
            return
          }
          await onGitRepoReady(repo.id, source)
        } else if (repo) {
          // Why: folder repos skip the Git default-checkout handoff and activate
          // their synthetic root workspace in the folder add flow.
          closeModal()
        }
      } finally {
        if (gen === localAddGenRef.current) {
          setNestedScanInProgress(false)
          setActiveNestedScanId(null)
          setIsAdding(false)
          setAddProjectBusyLabel(null)
        }
      }
    },
    [
      activeRuntimeEnvironmentId,
      addRepoPath,
      closeModal,
      fetchWorktrees,
      onGitRepoReady,
      scanNestedRepos,
      setActiveNestedScanId,
      setAddProjectBusyLabel,
      setIsAdding,
      setNestedScanInProgress,
      showNestedRepoReview
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
    void handleAddLocalPath(droppedLocalPath, 'local_folder_picker')
  }, [droppedLocalPath, handleAddLocalPath, isOpen])

  const handleBrowse = useCallback(async (): Promise<void> => {
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    setAddProjectBusyLabel('Choose a folder...')
    try {
      const path = await window.api.repos.pickFolder()
      if (!path || gen !== localAddGenRef.current) {
        return
      }
      await handleAddLocalPath(path, 'local_folder_picker')
    } finally {
      if (gen === localAddGenRef.current) {
        setIsAdding(false)
      }
    }
  }, [handleAddLocalPath, setAddProjectBusyLabel, setIsAdding])

  return { handleBrowse, resetLocalFolderFlow }
}
