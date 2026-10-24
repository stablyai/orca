import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import { track } from '@/lib/telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import {
  buildAddRepoExistingWorkspacesTelemetry,
  shouldTrackAddRepoExistingWorkspacesDetected
} from './add-repo-existing-workspaces-telemetry'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { finishProjectAddWithDefaultCheckout } from './project-added-default-checkout'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export type GitRepoAddOutcome = { importedProjectGroupId?: string }

export type CompleteGitRepoAdd = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId,
  outcome?: GitRepoAddOutcome
) => Promise<void>

type CompleteGitRepoAddOptions = {
  closeModal: () => void
  setHideDefaultBranchWorkspace: (hide: boolean) => void
  /** Why: the nested Add Project flow (hosted inside the workspace composer)
   *  keeps the composer open and selects the new project instead of running
   *  the default-checkout navigation handoff. Telemetry above still applies. */
  finishProjectAdd?: CompleteGitRepoAdd
}

export function useCompleteGitRepoAdd({
  closeModal,
  setHideDefaultBranchWorkspace,
  finishProjectAdd
}: CompleteGitRepoAddOptions): CompleteGitRepoAdd {
  const detectedTelemetryTrackedRef = useRef<Set<string>>(new Set())

  return useCallback(
    async (
      repoId: string,
      source: AddRepoExistingWorkspaceSource,
      executionHostId?: ExecutionHostId,
      outcome?: GitRepoAddOutcome
    ): Promise<void> => {
      const worktrees = (selectWorktreesByRepo(useAppStore.getState())[repoId] ?? []).filter(
        (worktree) =>
          executionHostId === undefined ||
          worktree.hostId === executionHostId ||
          (!worktree.hostId && executionHostId === 'local')
      )
      const sortedWorktrees = [...worktrees].sort((a, b) => {
        if (a.lastActivityAt !== b.lastActivityAt) {
          return b.lastActivityAt - a.lastActivityAt
        }
        return compareWorktreeDisplayName(a, b)
      })
      const existingWorkspaceTelemetry = buildAddRepoExistingWorkspacesTelemetry(
        source,
        sortedWorktrees
      )
      if (
        existingWorkspaceTelemetry &&
        shouldTrackAddRepoExistingWorkspacesDetected(existingWorkspaceTelemetry) &&
        !detectedTelemetryTrackedRef.current.has(repoId)
      ) {
        detectedTelemetryTrackedRef.current.add(repoId)
        track('add_repo_existing_workspaces_detected', existingWorkspaceTelemetry)
      }
      if (finishProjectAdd) {
        await finishProjectAdd(repoId, source, executionHostId, outcome)
        return
      }
      await finishProjectAddWithDefaultCheckout({
        repoId,
        source,
        executionHostId,
        closeModal,
        setHideDefaultBranchWorkspace
      })
    },
    [closeModal, finishProjectAdd, setHideDefaultBranchWorkspace]
  )
}
