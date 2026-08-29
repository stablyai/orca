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
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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
  setAddProjectBusyLabel
}: {
  addRepoPath: (
    path: string,
    kind?: 'git' | 'folder',
    options?: { runtimeEnvironmentId?: string | null }
  ) => Promise<Repo | null>
  activeRuntimeEnvironmentId: string | null
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  scanNestedRepos: (
    path: string,
    connectionId?: string,
    controls?: {
      scanId?: string
      onProgress?: (scan: NestedRepoScanResult) => void
      runtimeEnvironmentId?: string | null
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
      const gen = ++serverAddGenRef.current
      setIsAddingServerPath(true)
      setAddProjectBusyLabel(kind === 'git' ? 'Scanning for repositories...' : 'Opening folder...')
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
        setAddProjectBusyLabel(kind === 'git' ? 'Opening project...' : 'Opening folder...')
        const repo = await addRepoPath(path, kind, {
          runtimeEnvironmentId: activeRuntimeEnvironmentId
        })
        if (gen !== serverAddGenRef.current) {
          return
        }
        if (repo && isGitRepoKind(repo)) {
          // Why: once the repo exists, a transient non-authoritative refresh
          // should fall through to project reveal instead of leaving the add flow open.
          const ownerOptions = worktreeRefreshOptions(activeRuntimeEnvironmentId ?? null)
          await fetchWorktrees(repo.id, ownerOptions)
          if (gen !== serverAddGenRef.current) {
            return
          }
          await onGitRepoReady(repo.id, 'runtime_server_path', ownerOptions.executionHostId)
        } else if (repo) {
          // Why: folder repos skip the Git default-checkout handoff; their synthetic
          // root workspace is opened by the folder add flow.
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
