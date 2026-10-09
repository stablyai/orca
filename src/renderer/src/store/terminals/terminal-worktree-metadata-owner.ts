import type { AppState } from '../types'
import type { WorktreePassiveMetadataOwner } from '../slices/worktree-helpers'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'
import { capturePassiveWorktreeMetaOwner } from '../slices/worktrees/listing/worktree-owner-settings'

export function captureTerminalWorktreeMetadataOwner(
  state: AppState,
  worktreeId: string,
  ptyIds: readonly string[]
): WorktreePassiveMetadataOwner | undefined {
  const routes = new Map<string, NonNullable<ReturnType<typeof resolveTerminalNotificationOwner>>>()
  for (const ptyId of ptyIds) {
    const route = resolveTerminalNotificationOwner(state, worktreeId, { ptyId })
    if (!route) {
      return undefined
    }
    routes.set(JSON.stringify(route), route)
  }
  const route = routes.values().next().value
  return routes.size === 1 && route
    ? capturePassiveWorktreeMetaOwner(state, worktreeId, route)
    : undefined
}
