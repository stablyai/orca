import { useEffect } from 'react'

/** Suspends global shortcuts while a recorder is listening, so recorded chords reach it. */
export function useShortcutRecorderFocus(recording: boolean): void {
  useEffect(() => {
    window.api.ui.setShortcutRecorderFocused(recording)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recording])
}
