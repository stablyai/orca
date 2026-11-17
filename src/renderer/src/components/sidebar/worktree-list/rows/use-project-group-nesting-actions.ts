import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/sections/group-keys'

// Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
function reportProjectGroupMoveFailure(): void {
  toast.error(
    translate(
      'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.009a0dfef9',
      'Failed to move group'
    ),
    {
      description: translate(
        'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.b1ba3948b3',
        "Orca could not confirm the move with the group's host. Recheck the group after reconnecting, or update Orca on that host."
      )
    }
  )
}

function reportProjectSubgroupCreateFailure(): void {
  toast.error(
    translate(
      'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.8269fcd14a',
      'Failed to create subgroup'
    ),
    {
      description: translate(
        'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.daf08d9e4e',
        "Orca could not confirm the new group with the parent group's host. Recheck the sidebar after reconnecting."
      )
    }
  )
}

/** Subgroup creation and group moves; both reveal the result since its new parent may be collapsed. */
export function useProjectGroupNestingActions() {
  const createProjectSubgroup = useAppStore((s) => s.createProjectSubgroup)
  const moveProjectGroup = useAppStore((s) => s.moveProjectGroup)
  const revealSidebarRow = useAppStore((s) => s.revealSidebarRow)

  const handleMoveProjectGroup = useCallback(
    async (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => {
      if (await moveProjectGroup(groupId, parentGroupId, { hostId })) {
        revealSidebarRow(getProjectGroupHeaderKey(groupId))
      } else {
        reportProjectGroupMoveFailure()
      }
    },
    [moveProjectGroup, revealSidebarRow]
  )

  const submitProjectSubgroup = useCallback(
    async (name: string, parentGroupId: string, hostId?: ExecutionHostId) => {
      const group = await createProjectSubgroup(name, parentGroupId, { hostId })
      if (group) {
        revealSidebarRow(getProjectGroupHeaderKey(group.id))
      } else {
        reportProjectSubgroupCreateFailure()
      }
    },
    [createProjectSubgroup, revealSidebarRow]
  )

  return { handleMoveProjectGroup, submitProjectSubgroup }
}
