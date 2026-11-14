import type React from 'react'
import { useWorktreeListKeyboardNavigation } from '../navigation/use-keyboard'
import { resolveSidebarWorkspaceDeleteIntent } from '../navigation/sidebar-workspace-delete'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'

export function useWorktreeViewportKeyboardNavigation(args: {
  props: VirtualizedWorktreeViewportProps
  scrollRef: React.RefObject<HTMLDivElement | null>
  markDirectScrollInput: () => void
}) {
  const { props, scrollRef, markDirectScrollInput } = args
  return useWorktreeListKeyboardNavigation({
    rows: props.rows,
    activeWorktreeId: props.activeWorktreeId,
    activeWorkspaceExecutionHostId: props.activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy: props.pinnedDisplayPolicy,
    scrollRef,
    activeModal: props.activeModal,
    markDirectScrollInput,
    onKeyboardSelect: props.onKeyboardSelect,
    focusedWorktree: props.focusedWorktree,
    focusedWorkspaceExecutionHostId: props.focusedWorkspaceExecutionHostId,
    resolveDeleteIntent: () =>
      resolveSidebarWorkspaceDeleteIntent({
        selectedWorktrees: props.selectedWorktrees,
        focusedWorktree: props.focusedWorktree ?? null,
        repoMap: props.repoMap
      })
  })
}
