import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { selectWorktreeActivityStatus } from './use-worktree-activity-status'

function selectStatusesForIds(worktreeIds: readonly string[]) {
  let previous = new Map<string, WorktreeStatus>()
  return (state: AppState) => {
    let next = previous
    for (const id of worktreeIds) {
      const status = selectWorktreeActivityStatus(state, id)
      if (next.get(id) !== status) {
        if (next === previous) {
          next = new Map(previous)
        }
        next.set(id, status)
      }
    }
    previous = next
    return next
  }
}

export function useWorktreeActivityStatuses(
  worktreeIds: readonly string[]
): Map<string, WorktreeStatus> {
  const selectStatuses = useMemo(() => selectStatusesForIds(worktreeIds), [worktreeIds])
  return useAppStore(useShallow(selectStatuses))
}
