import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { track } from '@/lib/telemetry'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
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
import { createNestedRepoScanId } from './add-repo-dialog-types'
import { addedRepoRefreshOptions } from './add-repo-runtime-owner'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  wslHostWindowsDriveRefusalForLinuxPath,
  type WslHostWindowsDriveRefusal
} from '../../../../shared/wsl-host-windows-drive-refusal'
import { getWindowsPathAccess } from '@/lib/windows-path-access'
import type { AddRepoPathOptions } from '@/store/repos/repo-state'
import { addRepoBusyLabels } from './add-repo-busy-labels'

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

export function useAddRepoServerPathFlow({
  addRepoPath,
  activeRuntimeEnvironmentId,
  closeModal,
  fetchWorktrees,
  getNestedRepoRuntimeKind,
  scanNestedRepos,
  setActiveNestedScanId,
  setNestedScanInProgress,
  showNestedRepoReview,
  onGitRepoReady,
  setAddProjectBusyLabel,
  onWindowsDriveRefusal
}: {
  addRepoPath: (
    path: string,
    kind?: 'git' | 'folder',
    options?: AddRepoPathOptions
  ) => Promise<Repo | null>
  activeRuntimeEnvironmentId: string | null
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  scanNestedRepos: (
    path: string,
    connectionId: string | undefined,
    controls: {
      scanId?: string
      onProgress?: (scan: NestedRepoScanResult) => void
      runtimeEnvironmentId: string | null
    }
  ) => Promise<NestedRepoScanResult | null>
  setActiveNestedScanId: (scanId: string | null, runtimeEnvironmentId?: string | null) => void
  setNestedScanInProgress: (inProgress: boolean) => void
  showNestedRepoReview: ShowNestedRepoReview
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  setAddProjectBusyLabel: (label: string | null) => void
  /** Shown inline by the dialog, whether this client or the host refused. */
  onWindowsDriveRefusal: (refusal: WslHostWindowsDriveRefusal) => void
}): {
  serverPath: string
  isAddingServerPath: boolean
  setServerPath: Dispatch<SetStateAction<string>>
  resetServerPathFlow: () => void
  handleAddServerPath: (kind: 'git' | 'folder') => Promise<void>
} {
  const [serverPath, setServerPath] = useState('')
  const [isAddingServerPath, setIsAddingServerPath] = useState(false)
  const serverAddGenRef = useRef(0)

  const resetServerPathFlow = useCallback((): void => {
    serverAddGenRef.current++
    setServerPath('')
    setIsAddingServerPath(false)
  }, [])

  const handleAddServerPath = useCallback(
    async (kind: 'git' | 'folder'): Promise<void> => {
      const path = serverPath.trim()
      if (!path) {
        return
      }
      // A WSL host refuses /mnt/<drive> up front, before a slow drvfs scan; the host re-checks by mount.
      const driveRefusal =
        activeRuntimeEnvironmentId &&
        getWindowsPathAccess(toRuntimeExecutionHostId(activeRuntimeEnvironmentId))
          ? wslHostWindowsDriveRefusalForLinuxPath(path)
          : null
      if (driveRefusal) {
        onWindowsDriveRefusal(driveRefusal)
        return
      }
      const gen = ++serverAddGenRef.current
      setIsAddingServerPath(true)
      setAddProjectBusyLabel(
        kind === 'git'
          ? addRepoBusyLabels.scanningRepositories()
          : addRepoBusyLabels.openingFolder()
      )
      try {
        if (kind === 'git') {
          const attemptId = createNestedRepoTelemetryAttemptId()
          const runtimeKind = getNestedRepoRuntimeKind(null)
          const supportsStreamingScan = runtimeKind !== 'runtime'
          const scanId = supportsStreamingScan ? createNestedRepoScanId() : null
          if (scanId) {
            setActiveNestedScanId(scanId, activeRuntimeEnvironmentId)
            setNestedScanInProgress(true)
          }
          const scan = await scanNestedRepos(path, undefined, {
            runtimeEnvironmentId: activeRuntimeEnvironmentId,
            ...(scanId
              ? {
                  scanId,
                  onProgress: (progressScan: NestedRepoScanResult) => {
                    if (
                      gen !== serverAddGenRef.current ||
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
                      runtimeKind,
                      inProgress: true,
                      scanId,
                      runtimeEnvironmentId: activeRuntimeEnvironmentId
                    })
                  }
                }
              : {})
          })
          if (gen !== serverAddGenRef.current) {
            return
          }
          setNestedScanInProgress(false)
          setActiveNestedScanId(null)
          track(
            'add_repo_nested_scan_result',
            buildNestedRepoScanTelemetry({
              attemptId,
              surface: 'sidebar',
              runtimeKind,
              scan
            })
          )
          if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
            showNestedRepoReview({
              scan,
              selectedPath: path,
              connectionId: null,
              attemptId,
              runtimeKind,
              inProgress: false,
              scanId,
              runtimeEnvironmentId: activeRuntimeEnvironmentId
            })
            return
          }
        }
        setAddProjectBusyLabel(
          kind === 'git' ? addRepoBusyLabels.openingProject() : addRepoBusyLabels.openingFolder()
        )
        const repo = await addRepoPath(path, kind, {
          runtimeEnvironmentId: activeRuntimeEnvironmentId,
          onWindowsDriveRefusal
        })
        if (gen !== serverAddGenRef.current) {
          return
        }
        if (repo && isGitRepoKind(repo)) {
          // A persisted repo should still reveal after a transient non-authoritative refresh.
          const ownerOptions = addedRepoRefreshOptions(repo)
          await fetchWorktrees(repo.id, ownerOptions)
          if (gen !== serverAddGenRef.current) {
            return
          }
          await onGitRepoReady(repo.id, 'runtime_server_path', ownerOptions.executionHostId)
        } else if (repo) {
          // Folder projects open their synthetic root through the add flow instead of Git checkout completion.
          await markOnboardingProjectAdded('addedFolder')
          closeModal()
        }
      } finally {
        if (gen === serverAddGenRef.current) {
          setNestedScanInProgress(false)
          setActiveNestedScanId(null)
          setIsAddingServerPath(false)
          setAddProjectBusyLabel(null)
        }
      }
    },
    [
      addRepoPath,
      activeRuntimeEnvironmentId,
      closeModal,
      fetchWorktrees,
      getNestedRepoRuntimeKind,
      onGitRepoReady,
      onWindowsDriveRefusal,
      scanNestedRepos,
      serverPath,
      setActiveNestedScanId,
      setAddProjectBusyLabel,
      setNestedScanInProgress,
      showNestedRepoReview
    ]
  )

  return { serverPath, isAddingServerPath, setServerPath, resetServerPathFlow, handleAddServerPath }
}
