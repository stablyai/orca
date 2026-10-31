import type React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/worktree-row-open-in-owner'
import type { Worktree } from '../../../../shared/worktree/types'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'

export function WorktreeRowOpenInSubMenu({
  worktree,
  connectionId,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'>
  connectionId: string | null
  disabled?: boolean
}): React.JSX.Element {
  // Resolve owner only while its menu is open, avoiding per-row work on unrelated store updates.
  const owner = useAppStore(useShallow((s) => resolveWorktreeRowOpenInRuntimeOwner(s, worktree)))
  return (
    <WorktreeOpenInSubMenu
      worktreePath={worktree.path}
      connectionId={owner.connectionId ?? connectionId}
      runtimeEnvironmentId={owner.runtimeEnvironmentId}
      ownerUnresolved={owner.ownerUnresolved}
      workspace={{ workspaceId: worktree.id, hostId: worktree.hostId }}
      disabled={disabled}
    />
  )
}
