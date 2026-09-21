import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import { browserOverlayOwnsShortcutTarget } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { isEditableKeyboardTarget } from '../host-guest/browser-keyboard'
import {
  REMOTE_BROWSER_FIND_UNAVAILABLE_NOTICE_ID,
  type RemoteBrowserPaneNotice
} from './remote-browser-page-input-model'

const FIND_UNAVAILABLE_NOTICE_MS = 4000

/**
 * Chords a streamed pane must answer itself rather than forward as keystrokes. browser.keypress
 * reaches the remote page through Input.dispatchKeyEvent, which cannot drive Chrome's own
 * browser-level UI — so a forwarded Cmd/Ctrl+R never reloaded and a forwarded Cmd/Ctrl+F never
 * opened anything. The capture listener also covers the screencast image, whose React key handler
 * would otherwise forward them: a capture-phase stopPropagation never reaches the target.
 */
export function useRemoteBrowserPageChromeChords({
  chromeShortcutScope,
  workspaceId,
  runRemoteNavigation,
  setPaneNotice
}: {
  chromeShortcutScope: BrowserChromeShortcutScope
  workspaceId: string
  runRemoteNavigation: (method: 'browser.reload') => Promise<void> | void
  setPaneNotice: Dispatch<SetStateAction<RemoteBrowserPaneNotice | null>>
}): void {
  const keybindings = useAppStore((state) => state.keybindings)
  const findNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Why: isActive is true for the active tab of every split group, so gating on it would swallow
    // these chords from a focused terminal in a sibling split (#11348).
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        chromeShortcutScope === 'owned-target' &&
        !browserOverlayOwnsShortcutTarget(event.target, workspaceId)
      ) {
        return
      }
      // Why: Cmd+F should open find even from the address bar (Chrome/Safari do), but reload must
      // not fire while the user is typing a URL.
      if (keybindingMatchesAction('browser.find', event, shortcutPlatform, keybindings)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        // Why: the pane shows decoded frames, not a live DOM, so there is nothing here to search.
        // Saying so beats forwarding a keystroke that provably does nothing on the host.
        // 'consequence' keeps a live stream error (which sits next to Reconnect) ranked above it,
        // and the id makes OS key repeat a no-op instead of a re-render of the screencast image.
        setPaneNotice((current) =>
          current?.id === REMOTE_BROWSER_FIND_UNAVAILABLE_NOTICE_ID
            ? current
            : {
                id: REMOTE_BROWSER_FIND_UNAVAILABLE_NOTICE_ID,
                kind: 'consequence',
                text: translate(
                  'browser.remote.findUnavailable',
                  'Find in page is not available while this page streams from the remote host.'
                )
              }
        )
        if (findNoticeTimerRef.current !== null) {
          clearTimeout(findNoticeTimerRef.current)
        }
        findNoticeTimerRef.current = setTimeout(() => {
          findNoticeTimerRef.current = null
          // Only retract our own notice; anything raised since then owns the slot.
          setPaneNotice((current) =>
            current?.id === REMOTE_BROWSER_FIND_UNAVAILABLE_NOTICE_ID ? null : current
          )
        }, FIND_UNAVAILABLE_NOTICE_MS)
        return
      }
      const isHardReload = keybindingMatchesAction(
        'browser.hardReload',
        event,
        shortcutPlatform,
        keybindings
      )
      const isReload = keybindingMatchesAction(
        'browser.reload',
        event,
        shortcutPlatform,
        keybindings
      )
      if (!isHardReload && !isReload) {
        return
      }
      if (isEditableKeyboardTarget(event.target)) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      // Why: the runtime exposes one reload; a hard reload would need a wire change, so both
      // chords land on it rather than one of them silently doing nothing.
      void runRemoteNavigation('browser.reload')
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      if (findNoticeTimerRef.current !== null) {
        clearTimeout(findNoticeTimerRef.current)
        findNoticeTimerRef.current = null
      }
    }
  }, [chromeShortcutScope, keybindings, runRemoteNavigation, setPaneNotice, workspaceId])
}
