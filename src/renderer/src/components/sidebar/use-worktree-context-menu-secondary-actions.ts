import { useCallback } from 'react'
import type { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { unnestWorktrees } from './worktree-unnest'
import { shouldSuppressContextMenuFollowUpClick } from './worktree-context-menu-policy'

export function useWorktreeContextMenuSecondaryActions(args: {
  activeContextWorktrees: readonly Worktree[]
  contextMenuOpenedAtRef: React.MutableRefObject<number | null>
  updateWorktreeLineage: ReturnType<typeof useAppStore.getState>['updateWorktreeLineage']
}) {
  const handleRemoveParentLink = useCallback(() => {
    void unnestWorktrees(
      args.activeContextWorktrees.map((item) => item.id),
      args.updateWorktreeLineage
    )
  }, [args])
  const suppressOpeningPointerEvent = useCallback(
    (event: React.SyntheticEvent) => {
      const openedAt = args.contextMenuOpenedAtRef.current
      if (openedAt == null || !shouldSuppressContextMenuFollowUpClick(openedAt, Date.now())) {
        if (openedAt != null) {
          args.contextMenuOpenedAtRef.current = null
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'click') {
        args.contextMenuOpenedAtRef.current = null
      }
    },
    [args]
  )
  return { handleRemoveParentLink, suppressOpeningPointerEvent }
}
