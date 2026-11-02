import type React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/worktree-row-open-in-owner'
import type { Worktree } from '../../../../shared/worktree/types'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'

/** Open in submenu for one sidebar row, guarded by the host that owns that row. */
export function WorktreeRowOpenInSubMenu({
  worktree,
  connectionId,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'>
  connectionId: string | null
  disabled?: boolean
}): React.JSX.Element {
  // Why: resolved only while the menu is open, not per row on every store update.
  const owner = useAppStore(useShallow((s) => resolveWorktreeRowOpenInRuntimeOwner(s, worktree)))
  return (
    <WorktreeOpenInSubMenu
      worktreePath={worktree.path}
      connectionId={owner.connectionId ?? connectionId}
      runtimeEnvironmentId={owner.runtimeEnvironmentId}
      ownerUnresolved={owner.ownerUnresolved}
      disabled={disabled}
    />
  )
}
