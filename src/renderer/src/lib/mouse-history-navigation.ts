// Thumb-button (X1/X2) history navigation. DOM reports them as button 3/4;
// Electron performs no default navigation for them, so Orca routes them itself:
// over the worktree sidebar they walk the worktree stack, elsewhere (terminals,
// editors, browser panes alike) the per-worktree visited-tab stack.

export type MouseHistoryDirection = 'back' | 'forward'

export function mouseHistoryDirection(button: number): MouseHistoryDirection | null {
  if (button === 3) {
    return 'back'
  }
  if (button === 4) {
    return 'forward'
  }
  return null
}

export const WORKTREE_SIDEBAR_SURFACE_ATTRIBUTE = 'data-worktree-sidebar-surface'

// Why: thumb clicks over the worktree sidebar walk the worktree stack; over the tab
// content area they walk the per-worktree visited-tab stack instead.
export function isWorktreeSidebarSurfaceTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(`[${WORKTREE_SIDEBAR_SURFACE_ATTRIBUTE}]`) !== null
  )
}
