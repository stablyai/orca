import { useCallback, useMemo } from 'react'
import { useSidebarHostScopeOptions } from '../../worktree-list/controls/use-sidebar-host-scope-options'
import { getHostContextLabel } from '../../../../../../shared/worktree/host-context-labels'
import type { Worktree } from '../../../../../../shared/worktree/types'

/** The sidebar's own name for a parent candidate's machine, shown only for parents on another machine. */
export function useParentMachineLabel(
  isOnAnotherMachine: (candidate: Worktree) => boolean
): (candidate: Worktree) => string | undefined {
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
  return useCallback(
    (candidate) =>
      candidate.hostId && isOnAnotherMachine(candidate)
        ? getHostContextLabel(candidate.hostId, { hostLabelById })
        : undefined,
    [hostLabelById, isOnAnotherMachine]
  )
}
