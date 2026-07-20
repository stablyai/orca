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

/** Extra outcome the add flow carries into the handoff. */
export type GitRepoAddOutcome = {
  /** Root group a nested folder import created, when the user chose to import
   *  as a group. Hosts that can target a group prefer it over a member. */
  importedProjectGroupId?: string | undefined
}

/** Completion handoff shared by the add-repo flows: the added repo, its
 *  telemetry source, and any extra outcome hosts may act on. */
export type CompleteGitRepoAdd = (
  repoId: string,
  source: AddRepoExistingWorkspaceSource,
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
    async (repoId, source, outcome): Promise<void> => {
      const worktrees = useAppStore.getState().worktreesByRepo[repoId] ?? []
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
        await finishProjectAdd(repoId, source, outcome)
        return
      }
      await finishProjectAddWithDefaultCheckout({
        repoId,
        source,
        closeModal,
        setHideDefaultBranchWorkspace
      })
    },
    [closeModal, finishProjectAdd, setHideDefaultBranchWorkspace]
  )
}
