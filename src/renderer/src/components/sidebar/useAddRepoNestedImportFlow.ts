import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { getSelectedNestedRepoPathsInScanOrder } from '@/lib/nested-repo-selected-paths'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  shouldEmitNestedRepoImportSubmitTelemetry,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { NestedRepoScanResult, ProjectGroupImportResult } from '../../../../shared/types'

export function useAddRepoNestedImportFlow({
  nestedAttemptId,
  nestedScan,
  nestedSelectedPaths,
  nestedRuntimeKind,
  nestedConnectionId,
  nestedGroupName,
  nestedImportScanId,
  activeRuntimeEnvironmentId,
  fetchWorktrees,
  importNestedRepos,
  getNestedRepoRuntimeKind,
  onGitRepoReady,
  setIsAdding
}: {
  nestedAttemptId: string | null
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedRuntimeKind: NestedRepoTelemetryRuntimeKind | null
  nestedConnectionId: string | null
  nestedGroupName: string
  nestedImportScanId: string | null
  activeRuntimeEnvironmentId: string | null | undefined
  fetchWorktrees: (repoId: string, options?: { requireAuthoritative?: boolean }) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoTelemetryRuntimeKind
  onGitRepoReady: (repoId: string, source: AddRepoExistingWorkspaceSource) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
}): {
  handleImportNestedRepos: (mode: 'group' | 'separate') => Promise<void>
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
          // Why: Set insertion order can drift after deselect/reselect; import
          // ordering should match the visible scan order users reviewed.
          projectPaths: selectedProjectPaths,
          ...(nestedConnectionId ? { connectionId: nestedConnectionId } : {}),
          ...(nestedImportScanId ? { scanId: nestedImportScanId } : {}),
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
          const firstFailure = result.projects.find((entry) => entry.status === 'failed')?.error
          if (gen === nestedImportGenRef.current) {
            toast.error('No repositories imported', {
              description: firstFailure ?? undefined
            })
          }
          return
        }
        for (const projectId of importedRepoIds) {
          // Why: imported repos are already persisted; non-authoritative SSH
          // refreshes should not block revealing the first imported project.
          await fetchWorktrees(projectId, { requireAuthoritative: true })
        }
        if (gen !== nestedImportGenRef.current) {
          return
        }
        if (result.failedCount > 0) {
          toast.warning('Some repositories could not be imported', {
            description: `${result.failedCount} failed`
          })
        }
        const repo = useAppStore.getState().repos.find((entry) => entry.id === firstRepoId)
        if (repo) {
          const source: AddRepoExistingWorkspaceSource = nestedConnectionId
            ? 'ssh_remote_path'
            : activeRuntimeEnvironmentId?.trim()
              ? 'runtime_server_path'
              : 'local_folder_picker'
          await onGitRepoReady(repo.id, source)
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
      nestedRuntimeKind,
      nestedScan,
      nestedSelectedPaths,
      getNestedRepoRuntimeKind,
      onGitRepoReady,
      setIsAdding
    ]
  )

  return { handleImportNestedRepos, resetNestedImportFlow, trackNestedBackAction }
}
