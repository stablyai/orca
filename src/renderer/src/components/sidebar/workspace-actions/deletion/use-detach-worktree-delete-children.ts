import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { isValidResolvedWorktreeLineageEdge } from '../../../../../../shared/resolved-worktree-lineage'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import {
  getWorkspaceDeleteLineage,
  getWorkspaceDeleteLineageRecord
} from './workspace-delete-lineage'
import {
  canPreserveWorkspaceDeleteChildren,
  captureWorkspaceDeleteRowLookup,
  detachWorktreeDeleteChildren,
  workspaceDeleteTargetsMatch
} from './detach-worktree-delete-children'

async function runWithDetachCleanup(action: () => Promise<void>, cleanup: () => void) {
  try {
    await action()
  } finally {
    cleanup()
  }
}

export function useDetachWorktreeDeleteChildren({
  isOpen,
  parent,
  lineage,
  isFolderWorkspace,
  confirmedIdentities,
  resolveConfirmedTargets
}: {
  isOpen: boolean
  parent: Worktree | null | undefined
  lineage: ReturnType<typeof getWorkspaceDeleteLineage>
  isFolderWorkspace: boolean
  confirmedIdentities: readonly WorktreeDeleteIdentity[]
  resolveConfirmedTargets: (
    identities: readonly WorktreeDeleteIdentity[],
    expectedCount: number,
    options?: { includeMainWorktrees?: boolean }
  ) => Worktree[] | null
}) {
  const t = useTranslate()
  const [preserveChildren, setPreserve] = useState(false)
  const [isDetachingChildren, setIsDetachingChildren] = useState(false)
  const [detachError, setDetachError] = useState<string | null>(null)
  const canPreserveChildren =
    !!parent &&
    lineage.descendants.length > 0 &&
    canPreserveWorkspaceDeleteChildren(parent, lineage.descendants, isFolderWorkspace)

  if (!isOpen && (preserveChildren || detachError)) {
    setPreserve(false)
    setDetachError(null)
  }

  const detachChildren = async (onDetached: () => void): Promise<void> => {
    if (isDetachingChildren || !canPreserveChildren || !parent) {
      return
    }
    const confirmedTargets = resolveConfirmedTargets(
      confirmedIdentities,
      confirmedIdentities.length,
      { includeMainWorktrees: true }
    )
    if (!confirmedTargets) {
      return
    }
    const changedError = () =>
      new Error(
        t(
          'worktree.delete.childrenChanged',
          'Child workspaces changed. Review the workspace list and try again.'
        )
      )
    const assertCurrentTargets = (detached: boolean) => {
      const targets = resolveConfirmedTargets(confirmedIdentities, confirmedTargets.length, {
        includeMainWorktrees: true
      })
      const state = useAppStore.getState()
      const currentParent = targets?.find(
        (target) => getWorktreeHostIdentity(target) === getWorktreeHostIdentity(parent)
      )
      if (
        !targets ||
        !currentParent ||
        !canPreserveWorkspaceDeleteChildren(
          currentParent,
          targets.filter((target) => target !== currentParent),
          isFolderWorkspace
        )
      ) {
        throw changedError()
      }
      const currentLineage = getWorkspaceDeleteLineage(
        currentParent,
        getIndexedAllWorktrees(selectWorktreesByRepo(state)),
        state.worktreeLineageById
      )
      if (
        !workspaceDeleteTargetsMatch(confirmedTargets, currentLineage.descendants) ||
        (detached && currentLineage.descendants.length > 0)
      ) {
        throw changedError()
      }
      return currentLineage
    }
    setIsDetachingChildren(true)
    setDetachError(null)
    await runWithDetachCleanup(
      async () => {
        try {
          const currentLineage = assertCurrentTargets(false)
          const currentRow = captureWorkspaceDeleteRowLookup(
            selectWorktreesByRepo(useAppStore.getState()),
            confirmedTargets
          )
          await detachWorktreeDeleteChildren(
            currentLineage.directChildren,
            useAppStore.getState().updateWorktreeLineage,
            (child) => {
              const state = useAppStore.getState()
              const current = currentRow(selectWorktreesByRepo(state), child)
              const currentParent = currentRow(selectWorktreesByRepo(state), parent)
              if (
                !current ||
                current.instanceId !== child.instanceId ||
                !currentParent ||
                currentParent.instanceId !== parent.instanceId ||
                !canPreserveWorkspaceDeleteChildren(currentParent, [current], isFolderWorkspace)
              ) {
                throw changedError()
              }
              const edge = getWorkspaceDeleteLineageRecord(current, state.worktreeLineageById)
              return edge && isValidResolvedWorktreeLineageEdge(current, currentParent, edge)
                ? current
                : null
            },
            () => assertCurrentTargets(true)
          )
          onDetached()
        } catch (error) {
          setDetachError(
            t(
              'worktree.delete.detachFailed',
              'Could not detach all child workspaces. The parent was not deleted. {{error}}',
              { error: error instanceof Error ? error.message : String(error) }
            )
          )
        }
      },
      () => setIsDetachingChildren(false)
    )
  }

  return {
    preserveChildren,
    setPreserveChildren: (preserve: boolean) => {
      setPreserve(preserve)
      setDetachError(null)
    },
    isDetachingChildren,
    detachError,
    canPreserveChildren,
    detachChildren
  }
}
