import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/diagnostics/telemetry/telemetry'
import { useAppStore } from '@/store/index'
import { getSelectedNestedRepoPathsInScanOrder } from '@/lib/workspace/creation/nested-repo-selected-paths'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  shouldEmitNestedRepoImportSubmitTelemetry,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../../../shared/telemetry/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../../../shared/project/groups/project-group-types'
import type { WorktreeFetchOptions } from '@/store/slices/worktrees/listing/worktree-fetch-options'
import { worktreeRefreshOptions } from '../host-selection/add-repo-runtime-owner'
import { completeNestedFolderOpen } from './complete-nested-folder-open'
import {
  toastNoNestedRepositoriesImported,
  toastSomeNestedRepositoriesFailed
} from './nested-import-result-toasts'
import { defaultProjectGroupNameForPath } from '../dialog/add-repo-dialog-types'
import type { CompleteGitRepoAdd } from '../completion/use-complete-git-repo-add'
import type { NestedProjectReporter } from './useAddRepoNestedReviewState'
import type { PausedLocalPathAdd } from '../dialog/add-repo-local-path-batch'

export function useAddRepoNestedImportFlow({
  nestedAttemptId,
  nestedScan,
  nestedSelectedPaths,
  nestedRuntimeKind,
  nestedConnectionId,
  nestedGroupName,
  nestedImportScanId,
  nestedRuntimeEnvironmentId,
  activeRuntimeEnvironmentId,
  closeModal,
  fetchWorktrees,
  importNestedRepos,
  getNestedRepoRuntimeKind,
  onGitRepoReady,
  setIsAdding,
  takeNestedProjectReporter
}: {
  nestedAttemptId: string | null
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedRuntimeKind: NestedRepoTelemetryRuntimeKind | null
  nestedConnectionId: string | null
  nestedGroupName: string
  nestedImportScanId: string | null
  nestedRuntimeEnvironmentId: string | null
  activeRuntimeEnvironmentId: string | null | undefined
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    runtimeEnvironmentId: string | null
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  onGitRepoReady: CompleteGitRepoAdd
  setIsAdding: (isAdding: boolean) => void
  takeNestedProjectReporter: () => NestedProjectReporter | null
}): {
  handleImportNestedRepos: (mode: 'group' | 'separate') => Promise<void>
  handleOpenNestedRootFolder: () => Promise<void>
  resetNestedImportFlow: () => void
  trackNestedBackAction: () => void
} {
  const nestedImportGenRef = useRef(0)
  const resetNestedImportFlow = useCallback((): void => {
    nestedImportGenRef.current++
  }, [])
  const trackNestedBackAction = useCallback((): void => {
    if (!nestedScan || !nestedAttemptId) {
      return
    }
    track(
      'add_repo_nested_import_action',
      buildNestedRepoImportActionTelemetry({
        attemptId: nestedAttemptId,
        surface: 'sidebar',
        runtimeKind: nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId),
        action: 'back',
        foundCount: nestedScan.repos.length,
        selectedCount: nestedSelectedPaths.size
      })
    )
  }, [
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedRuntimeKind,
    nestedScan,
    nestedSelectedPaths.size
  ])

  const handleImportNestedRepos = useCallback(
    async (mode: 'group' | 'separate'): Promise<void> => {
      const attemptId = nestedAttemptId
      if (
        !nestedScan ||
        !attemptId ||
        !shouldEmitNestedRepoImportSubmitTelemetry({
          attemptId,
          selectedCount: nestedSelectedPaths.size
        })
      ) {
        return
      }
      const foundCount = nestedScan.repos.length
      const selectedCount = nestedSelectedPaths.size
      const selectedProjectPaths = getSelectedNestedRepoPathsInScanOrder(
        nestedScan,
        nestedSelectedPaths
      )
      const runtimeKind = nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId)
      const gen = ++nestedImportGenRef.current
      setIsAdding(true)
      track(
        'add_repo_nested_import_action',
        buildNestedRepoImportActionTelemetry({
          attemptId,
          surface: 'sidebar',
          runtimeKind,
          action: mode === 'group' ? 'import_group' : 'import_separate',
          foundCount,
          selectedCount
        })
      )
      let resultTracked = false
      try {
        const result = await importNestedRepos({
          parentPath: nestedScan.selectedPath,
          groupName: nestedGroupName,
          projectPaths: selectedProjectPaths,
          ...(nestedConnectionId ? { connectionId: nestedConnectionId } : {}),
          ...(nestedImportScanId ? { scanId: nestedImportScanId } : {}),
          runtimeEnvironmentId: nestedRuntimeEnvironmentId,
          mode
        })
        track(
          'add_repo_nested_import_result',
          buildNestedRepoImportResultTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind,
            mode,
            foundCount,
            selectedCount,
            result
          })
        )
        resultTracked = true
        if (!result) {
          return
        }
        const importedRepoIds = result.projects
          .map((entry) => entry.projectId)
          .filter((projectId): projectId is string => typeof projectId === 'string')
        const firstRepoId = importedRepoIds[0]
        if (!firstRepoId) {
          if (gen === nestedImportGenRef.current) {
            toastNoNestedRepositoriesImported(
              result.projects.find((entry) => entry.status === 'failed')
            )
          }
          return
        }
        const completionOwner = nestedConnectionId === null ? nestedRuntimeEnvironmentId : undefined
        const completionOwnerOptions = worktreeRefreshOptions(completionOwner, nestedConnectionId)
        for (const projectId of importedRepoIds) {
          await fetchWorktrees(projectId, completionOwnerOptions)
        }
        if (gen !== nestedImportGenRef.current) {
          return
        }
        if (result.failedCount > 0) {
          toastSomeNestedRepositoriesFailed(result.failedCount)
        }
        const repo = useAppStore.getState().repos.find((entry) => entry.id === firstRepoId)
        if (repo) {
          const source: AddRepoExistingWorkspaceSource = nestedConnectionId
            ? 'ssh_remote_path'
            : activeRuntimeEnvironmentId?.trim()
              ? 'runtime_server_path'
              : 'local_folder_picker'
          // Why: the close inside onGitRepoReady resets review, so take the reporter first and
          // report after, letting the move open once the dialog closed, as for a plain repo add.
          const reportProject = takeNestedProjectReporter()
          let added: PausedLocalPathAdd | null = null
          try {
            await onGitRepoReady(
              repo.id,
              source,
              completionOwnerOptions.executionHostId,
              mode === 'group' && result.group
                ? { importedProjectGroupId: result.group.id }
                : undefined
            )
            // Every imported repo starts checked, so a new group is not split across hosts.
            added = { repo, imported: importedRepoIds.map((id) => ({ kind: 'repo', id })) }
          } finally {
            reportProject?.(added)
          }
        }
      } catch (err) {
        if (gen === nestedImportGenRef.current) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!resultTracked) {
          track(
            'add_repo_nested_import_result',
            buildNestedRepoImportResultTelemetry({
              attemptId,
              surface: 'sidebar',
              runtimeKind,
              mode,
              foundCount,
              selectedCount,
              result: null
            })
          )
        }
        if (gen === nestedImportGenRef.current) {
          setIsAdding(false)
        }
      }
    },
    [
      activeRuntimeEnvironmentId,
      fetchWorktrees,
      importNestedRepos,
      nestedAttemptId,
      nestedConnectionId,
      nestedGroupName,
      nestedImportScanId,
      nestedRuntimeEnvironmentId,
      nestedRuntimeKind,
      nestedScan,
      nestedSelectedPaths,
      getNestedRepoRuntimeKind,
      onGitRepoReady,
      setIsAdding,
      takeNestedProjectReporter
    ]
  )
  const handleOpenNestedRootFolder = useCallback(() => {
    if (!nestedScan) {
      return Promise.resolve()
    }
    const generation = ++nestedImportGenRef.current
    // Only edited names override host defaults, such as an SSH label for its home directory.
    const enteredName = nestedGroupName.trim()
    const displayName =
      enteredName && enteredName !== defaultProjectGroupNameForPath(nestedScan.selectedPath)
        ? enteredName
        : undefined
    return completeNestedFolderOpen({
      scan: nestedScan,
      generation,
      currentGeneration: () => nestedImportGenRef.current,
      attemptId: nestedAttemptId,
      runtimeKind: nestedRuntimeKind,
      connectionId: nestedConnectionId,
      selectedCount: nestedSelectedPaths.size,
      getRuntimeKind: getNestedRepoRuntimeKind,
      owner: nestedRuntimeEnvironmentId,
      ...(displayName ? { displayName } : {}),
      closeModal,
      reportProject: (repo) => takeNestedProjectReporter()?.({ repo }),
      setIsAdding
    })
  }, [
    closeModal,
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedGroupName,
    nestedRuntimeKind,
    nestedRuntimeEnvironmentId,
    nestedScan,
    nestedSelectedPaths.size,
    setIsAdding,
    takeNestedProjectReporter
  ])
  return {
    handleImportNestedRepos,
    handleOpenNestedRootFolder,
    resetNestedImportFlow,
    trackNestedBackAction
  }
}
