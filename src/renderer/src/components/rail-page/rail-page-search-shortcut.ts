import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import {
  hasVisibleOverlay,
  OVERLAY_LAYER_SELECTOR
} from '@/lib/overlay-interaction/visible-overlay'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

const NON_PAGE_FOCUS = [
  OVERLAY_LAYER_SELECTOR,
  '[inert]',
  '[data-native-chat-root]',
  '[data-native-chat-rail-panel]',
  '[data-browser-page-pane-id]',
  '[data-browser-overlay-tab-id]',
  '[data-terminal-tab-id]',
  '.monaco-editor'
].join(', ')

function isTextEntry(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

function isSearchControlVisible(control: HTMLInputElement | HTMLButtonElement | null): boolean {
  return (
    !!control &&
    !control.disabled &&
    !control.closest('[inert]') &&
    control.checkVisibility({ checkVisibilityCSS: true }) &&
    control.getClientRects().length > 0
  )
}

export type RailPageSearchShortcutContext = {
  target: EventTarget | null
  root: HTMLElement | null
  input: HTMLInputElement | null
  trigger: HTMLButtonElement | null
  modalOpen: boolean
  overlayOpen: boolean
  webClient: boolean
}

/** Whether a matched ⌘F should focus this page's search (D1 R1 + R2). Pure so the rules are testable. */
export function shouldFocusRailPageSearch({
  target,
  root,
  input,
  trigger,
  modalOpen,
  overlayOpen,
  webClient
}: RailPageSearchShortcutContext): boolean {
  // The web client keeps the browser's own Find.
  if (webClient || modalOpen || overlayOpen || !root || !input) {
    return false
  }
  if (!isSearchControlVisible(input) && !isSearchControlVisible(trigger)) {
    return false
  }
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (!element || element === document.body || element === document.documentElement) {
    return true
  }
  if (element.closest(NON_PAGE_FOCUS)) {
    return false
  }
  // A text field other than the search keeps every key, as Tasks' own handler did.
  if (element !== input && isTextEntry(element)) {
    return false
  }
  return !element.closest('[data-app-page-column]') || root.contains(element)
}

/**
 * Binds `page.search` (Mod+F by default) to `inputRef` while `enabled`. Registered on the app key router like Tasks'
 * old handler, so focused hidden terminals never see the chord.
 */
export function useRailPageSearchShortcut({
  rootRef,
  inputRef,
  triggerRef,
  openForShortcut,
  enabled
}: {
  rootRef: React.RefObject<HTMLElement | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  openForShortcut: () => void
  enabled: boolean
}): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      const { keybindings, activeModal } = useAppStore.getState()
      if (!keybindingMatchesAction('page.search', event, getShortcutPlatform(), keybindings)) {
        return
      }
      const input = inputRef.current
      if (
        !shouldFocusRailPageSearch({
          target: event.target,
          root: rootRef.current,
          input,
          trigger: triggerRef.current,
          modalOpen: activeModal !== 'none',
          overlayOpen: hasVisibleOverlay(),
          webClient: isWebClientLocation()
        })
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (isSearchControlVisible(input)) {
        input?.focus()
        input?.select()
      } else {
        openForShortcut()
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [enabled, inputRef, openForShortcut, rootRef, triggerRef])
}
