import { useEffect } from 'react'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

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
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [enabled, isOpen, onContinue])
}
