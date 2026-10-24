import { cancelPendingEditorLineRevealFrames } from '@/store/slices/editor/focus/editor-focus-reveal'

let latestOpenDetectedFilePathRequestId = 0

/** Supersedes earlier opens now, for a click still deciding what to open; true until a later open. */
export function reserveDetectedFilePathOpenTurn(): () => boolean {
  const requestId = ++latestOpenDetectedFilePathRequestId
  cancelPendingEditorLineRevealFrames()
  return () => requestId === latestOpenDetectedFilePathRequestId
}
