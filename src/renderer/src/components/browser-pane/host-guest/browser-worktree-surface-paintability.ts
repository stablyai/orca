// The worktree-surface twin of browser-page-paintability.ts. This surface is a STRICT ANCESTOR of
// every guest in the worktree, so parking it `hidden` stops their screencasts no matter what the
// pane-level term says. Required fields, not an inline OR-list: a new retention term then breaks
// the call site at typecheck instead of silently reaching only the panes.

export type HiddenBrowserWorktreeSurfaceState = {
  shouldMeasureHiddenWorktree: boolean
  needsBrowserGuestPaint: boolean
}

export function shouldKeepHiddenWorktreeSurfacePaintable({
  shouldMeasureHiddenWorktree,
  needsBrowserGuestPaint
}: HiddenBrowserWorktreeSurfaceState): boolean {
  return shouldMeasureHiddenWorktree || needsBrowserGuestPaint
}

export type RetainedBrowserOverlayMountState = {
  isWorktreeVisible: boolean
  // Why: deferral is the budgeted path; without a budget every tab mounts anyway.
  hasDeferredBackgroundMounts: boolean
  needsBrowserGuestPaint: boolean
}

export function shouldMountRetainedBrowserOverlay({
  isWorktreeVisible,
  hasDeferredBackgroundMounts,
  needsBrowserGuestPaint
}: RetainedBrowserOverlayMountState): boolean {
  return isWorktreeVisible || !hasDeferredBackgroundMounts || needsBrowserGuestPaint
}
