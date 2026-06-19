export type RightPanelCommentFocusTimerRef = {
  current: ReturnType<typeof setTimeout> | null
}

export function clearRightPanelCommentFocusTimer(timerRef: RightPanelCommentFocusTimerRef): void {
  if (timerRef.current === null) {
    return
  }
  clearTimeout(timerRef.current)
  timerRef.current = null
}

export function scheduleRightPanelCommentFocusTimer(
  timerRef: RightPanelCommentFocusTimerRef,
  callback: () => void
): void {
  // Why: right-sidebar panels can unmount before deferred focus work runs.
  // Replacing the pending timer keeps stale focus callbacks from surviving.
  clearRightPanelCommentFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    callback()
  }, 0)
}
