import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { track } from '@/lib/telemetry'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import { createNestedRepoScanId, type AddRepoDialogStep } from './add-repo-dialog-types'

type ShowNestedRepoReview = (args: {
  scan: NestedRepoScanResult
  selectedPath: string
  connectionId: string | null
  attemptId: string
  runtimeKind: NestedRepoTelemetryRuntimeKind
  inProgress: boolean
  scanId: string | null
}) => void

export function useAddRepoServerPathFlow({
  addRepoPath,
  closeModal,
  fetchWorktrees,
  getNestedRepoRuntimeKind,
  scanNestedRepos,
  setActiveNestedScanId,
  setNestedScanInProgress,
  showNestedRepoReview,
  setStep,
  setAddedRepo,
  setExistingWorkspaceSource,
  setAddProjectBusyLabel
}: {
  addRepoPath: (path: string, kind?: 'git' | 'folder') => Promise<Repo | null>
  closeModal: () => void
  fetchWorktrees: (repoId: string) => Promise<unknown>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  scanNestedRepos: (
    path: string,
    connectionId?: string,
    controls?: { scanId?: string; onProgress?: (scan: NestedRepoScanResult) => void }
  ) => Promise<NestedRepoScanResult | null>
  setActiveNestedScanId: (scanId: string | null) => void
  setNestedScanInProgress: (inProgress: boolean) => void
  showNestedRepoReview: ShowNestedRepoReview
  setStep: (step: AddRepoDialogStep) => void
  setAddedRepo: (repo: Repo | null) => void
  setExistingWorkspaceSource: (source: AddRepoExistingWorkspaceSource | null) => void
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
            setActiveNestedScanId(scanId)
            setNestedScanInProgress(true)
          }
          const scan = await scanNestedRepos(
            path,
            undefined,
            scanId
              ? {
                  scanId,
                  onProgress: (progressScan) => {
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
                      scanId
                    })
                  }
                }
              : undefined
          )
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
              scanId
            })
            return
          }
        }
        setAddProjectBusyLabel(kind === 'git' ? 'Opening project...' : 'Opening folder...')
        const repo = await addRepoPath(path, kind)
        if (gen !== serverAddGenRef.current) {
          return
        }
        if (repo && isGitRepoKind(repo)) {
          setAddedRepo(repo)
          setExistingWorkspaceSource('runtime_server_path')
          await fetchWorktrees(repo.id)
          if (gen !== serverAddGenRef.current) {
            return
          }
          setStep('setup')
        } else if (repo) {
          // Why: folder repos skip the Git worktree setup step; their synthetic
          // root workspace is opened by the folder add flow.
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
      closeModal,
      fetchWorktrees,
      getNestedRepoRuntimeKind,
      scanNestedRepos,
      serverPath,
      setActiveNestedScanId,
      setAddProjectBusyLabel,
      setAddedRepo,
      setExistingWorkspaceSource,
      setNestedScanInProgress,
      setStep,
      showNestedRepoReview
    ]
  )

  return { serverPath, isAddingServerPath, setServerPath, resetServerPathFlow, handleAddServerPath }
}
