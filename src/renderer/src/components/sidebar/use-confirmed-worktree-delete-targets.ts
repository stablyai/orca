import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  getRegisteredWorktreeDeleteTarget,
  readWorktreeDeleteIdentities,
  resolveWorktreeBatchDeleteTargets,
  type WorktreeDeleteIdentity
} from './worktree-delete-request'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'

export function useConfirmedWorktreeDeleteTargets({
  worktreeIdentityData,
  lineageIdentityData,
  closeModal
}: {
  worktreeIdentityData: unknown
  lineageIdentityData: unknown
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
  const resolveConfirmedTargets = useCallback(
    (identities: readonly WorktreeDeleteIdentity[], expectedCount: number) => {
      const state = useAppStore.getState()
      const targets = resolveWorktreeBatchDeleteTargets(
        identities,
        (worktreeId, hostId, identity) =>
          getRegisteredWorktreeDeleteTarget(state, worktreeId, hostId, identity)
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

  return { worktreeDeleteIdentities, lineageDeleteIdentities, resolveConfirmedTargets }
}
