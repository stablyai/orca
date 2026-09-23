import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import { track } from '@/lib/telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import {
  buildAddRepoExistingWorkspacesTelemetry,
  shouldTrackAddRepoExistingWorkspacesDetected
} from './add-repo-existing-workspaces-telemetry'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { finishProjectAddWithDefaultCheckout } from './project-added-default-checkout'
import { pinAddedRepoWslRuntimePreference } from './add-repo-store-upsert'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type CompleteGitRepoAddOptions = {
  closeModal: () => void
  setHideDefaultBranchWorkspace: (hide: boolean) => void
  /** Why: the nested Add Project flow (hosted inside the workspace composer)
   *  keeps the composer open and selects the new project instead of running
   *  the default-checkout navigation handoff. Telemetry above still applies. */
  finishProjectAdd?: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
}

export function useCompleteGitRepoAdd({
  closeModal,
  setHideDefaultBranchWorkspace,
  finishProjectAdd
}: CompleteGitRepoAddOptions): (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
  executionHostId?: ExecutionHostId
) => Promise<void> {
  const detectedTelemetryTrackedRef = useRef<Set<string>>(new Set())

  return useCallback(
    async (
      repoId: string,
      source: AddRepoExistingWorkspaceSource,
      executionHostId?: ExecutionHostId
    ): Promise<void> => {
      // Why: a repo whose files live on \\wsl.localhost\<distro> runs in that
      // distro — pin the project runtime preference at add time so terminals,
      // agents and worktrees all resolve the same runtime (browse/clone/create
      // all funnel through here).
      const addedRepo = useAppStore.getState().repos.find((repo) => repo.id === repoId)
      const wslDistro = addedRepo ? parseWslUncPath(addedRepo.path)?.distro : null
      if (wslDistro) {
        pinAddedRepoWslRuntimePreference(repoId, wslDistro)
      }
      const worktrees = (useAppStore.getState().worktreesByRepo[repoId] ?? []).filter(
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
        await finishProjectAdd(repoId, source, executionHostId)
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
