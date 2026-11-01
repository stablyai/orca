// This ancestor can stop every guest’s screencast; required retention fields make missing call-site updates fail typechecking.

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
