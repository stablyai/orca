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
  // Replace deferred focus timers so callbacks cannot outlive an unmounted sidebar panel.
  clearRightPanelCommentFocusTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    callback()
  }, 0)
}
