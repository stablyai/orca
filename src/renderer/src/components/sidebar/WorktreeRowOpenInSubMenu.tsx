import type React from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'
import type { Worktree } from '../../../../shared/worktree/types'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'

/** Open in submenu for one sidebar row, guarded by the host that owns that row. */
export function WorktreeRowOpenInSubMenu({
  worktree,
  connectionId,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'path' | 'hostId'>
  connectionId: string | null
  disabled?: boolean
}): React.JSX.Element {
  // Why: resolved only while the menu is open, not per row on every store update. An inactive
  // row can name its host before the catalog has it, so the explicit host wins.
  const runtimeEnvironmentId = useAppStore((s) =>
    worktree.hostId
      ? (resolveWorktreeOperationRouteForHost(s, worktree.id, worktree.hostId)
          ?.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(s, worktree.id)
  )
  return (
    <WorktreeOpenInSubMenu
      worktreePath={worktree.path}
      connectionId={connectionId}
      runtimeEnvironmentId={runtimeEnvironmentId}
      disabled={disabled}
    />
  )
}
