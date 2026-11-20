import { useEffect } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { annotateLetterOwner } from '../../annotate/palette/annotate-esc-ownership'
import { isEditableKeyboardTarget } from './browser-keyboard'
import {
  browserGuestToolKeyFromEvent,
  isBrowserGrabActionKey,
  isBrowserGuestToolKey,
  type BrowserAnnotateToolKey,
  type BrowserGrabActionKey
} from '../../../../../../shared/browser/element-grab/browser-grab-types'

export function useBrowserAnnotateKeys({
  browserTabId,
  isActive,
  grabIsInteractive,
  markupIsActive,
  annotateToolOn = false,
  handleAnnotateToolKey,
  handleGrabActionShortcut
}: {
  browserTabId: string
  isActive: boolean
  grabIsInteractive: boolean
  markupIsActive: boolean
  annotateToolOn?: boolean
  handleAnnotateToolKey: (key: BrowserAnnotateToolKey) => void
  handleGrabActionShortcut: (key: BrowserGrabActionKey) => void
}): void {
  const annotateModeIsOn = grabIsInteractive || markupIsActive || annotateToolOn
  useEffect(() => {
    if (!annotateModeIsOn || !isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      // keyCode 229 marks IME composition on engines that don't set isComposing.
      if (
        isEditableKeyboardTarget(e.target) ||
        e.isComposing ||
        e.keyCode === 229 ||
        annotateLetterOwner(e.target) !== browserTabId
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.getModifierState?.('AltGraph')) {
        return
      }
      const key = browserGuestToolKeyFromEvent(e)
      if (!isBrowserGuestToolKey(key)) {
        return
      }
      if (isBrowserGrabActionKey(key)) {
        // Why: copy and screenshot only mean something while the picker runs, not while drawing.
        if (!grabIsInteractive) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        handleGrabActionShortcut(key)
        return
      }
      // Why: a held key would flip tools on every repeat.
      if (e.repeat) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleAnnotateToolKey(key)
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [
    annotateModeIsOn,
    browserTabId,
    grabIsInteractive,
    handleAnnotateToolKey,
    handleGrabActionShortcut,
    isActive
  ])

  useEffect(() => {
    if (!grabIsInteractive) {
      return
    }
    return window.api.browser.onGrabActionShortcut(({ browserPageId, key }) => {
      if (browserPageId !== browserTabId) {
        return
      }
      // Alt edges belong to the palette's see-through, which listens for them itself.
      if (key === 'alt-down' || key === 'alt-up') {
        return
      }
      if (isBrowserGrabActionKey(key)) {
        handleGrabActionShortcut(key)
      } else {
        handleAnnotateToolKey(key)
      }
    })
  }, [browserTabId, grabIsInteractive, handleAnnotateToolKey, handleGrabActionShortcut])
}
