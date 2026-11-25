import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import {
  readWorktreeDeleteIdentities,
  resolveWorktreeBatchDeleteTargets,
  type WorktreeDeleteIdentity
} from './worktree-delete-request'
import { showWorkspaceListChangedToast } from '../../worktree-list/listing/stale-workspace-list-toast'

export function useConfirmedWorktreeDeleteTargets({
  worktreeIdentityData,
  lineageIdentityData,
  preservationIdentityData,
  closeModal
}: {
  worktreeIdentityData: unknown
  lineageIdentityData: unknown
  preservationIdentityData: unknown
  closeModal: () => void
}) {
  const worktreeDeleteIdentities = useMemo(
    () => readWorktreeDeleteIdentities(worktreeIdentityData),
    [worktreeIdentityData]
  )
  const lineageDeleteIdentities = useMemo(
    () => readWorktreeDeleteIdentities(lineageIdentityData),
    [lineageIdentityData]
  )
  const lineagePreserveIdentities = useMemo(
    () => readWorktreeDeleteIdentities(preservationIdentityData ?? lineageIdentityData),
    [preservationIdentityData, lineageIdentityData]
  )
  const resolveConfirmedTargets = useCallback(
    (
      identities: readonly WorktreeDeleteIdentity[],
      expectedCount: number,
      options: { includeMainWorktrees?: boolean } = {}
    ) => {
      const state = useAppStore.getState()
      const targets = resolveWorktreeBatchDeleteTargets(
        identities,
        (worktreeId, hostId) => getWorktreeOnHostFromState(state, worktreeId, hostId),
        options
      )
      if (!targets || targets.length !== expectedCount) {
        showWorkspaceListChangedToast()
        closeModal()
        return null
      }
      return targets
    },
    [closeModal]
  )

  return {
    worktreeDeleteIdentities,
    lineageDeleteIdentities,
    lineagePreserveIdentities,
    resolveConfirmedTargets
  }
}
