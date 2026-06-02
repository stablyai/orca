import { useEffect } from 'react'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'

export function useFeatureWallTourKeyboardShortcut({
  isOpen,
  enabled,
  onContinue
}: {
  isOpen: boolean
  enabled: boolean
  onContinue: () => void
}): void {
  useEffect(() => {
    if (!isOpen || !enabled) {
      return
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      event.preventDefault()
      onContinue()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, isOpen, onContinue])
}
