import { useEffect, useState, type RefObject } from 'react'
import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatComposerSendIntent } from './native-chat-composer-types'
import { isMacPlatform } from './native-chat-shortcut'

/** What Cmd/Ctrl+Enter would do now: the typed draft the other way, or the head queued card in. */
export type NativeChatSteerChordPreview = NativeChatFollowUpBehavior | 'steer-queued'

// Long enough that Cmd+C, Cmd+V and other quick chords never flash the button.
export const NATIVE_CHAT_STEER_CHORD_HOLD_MS = 150

/** While the chord's modifier is held alone in this composer, Send shows what Cmd/Ctrl+Enter would do. */
export function useNativeChatSteerChordPreview(
  root: RefObject<HTMLElement | null>,
  /** The send's own resolver (`nativeChatComposerSendState`): `alternateSend` is undefined where the chord sends no differently. */
  { alternateSend, hasDraft }: { alternateSend?: NativeChatFollowUpBehavior; hasDraft: boolean },
  /** Present only while there is a head card to steer. */
  steerHead: (() => boolean) | undefined,
  send: (intent?: NativeChatComposerSendIntent) => void,
  /** An open picker takes Enter, so the chord previews nothing then. */
  pickerOpen: boolean
): { preview: NativeChatSteerChordPreview | null; runPreview: () => void } {
  const [held, setHeld] = useState(false)
  const enabled = alternateSend !== undefined
  useEffect(() => {
    const element = root.current
    if (!element || !enabled) {
      return
    }
    const mac = isMacPlatform()
    const chordKey = mac ? 'Meta' : 'Control'
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = (): void => {
      clearTimeout(timer)
      timer = undefined
      setHeld(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Any other key means a chord is under way (Enter included): it runs, the preview goes.
      // During IME composition the IME owns Enter, so the chord previews nothing either.
      if (event.key !== chordKey || event.isComposing) {
        release()
        return
      }
      // Shift or Alt already down makes it another chord (Shift steers the head card whatever is typed).
      const otherModifier = event.shiftKey || event.altKey || (mac ? event.ctrlKey : event.metaKey)
      if (otherModifier) {
        release()
      } else if (!event.repeat && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          // Cmd+Tab inside the delay leaves the window before the preview would show.
          setHeld(document.hasFocus())
        }, NATIVE_CHAT_STEER_CHORD_HOLD_MS)
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === chordKey) {
        release()
      }
    }
    element.addEventListener('keydown', onKeyDown)
    element.addEventListener('keyup', onKeyUp)
    element.addEventListener('focusout', release)
    element.addEventListener('compositionstart', release)
    return () => {
      element.removeEventListener('keydown', onKeyDown)
      element.removeEventListener('keyup', onKeyUp)
      element.removeEventListener('focusout', release)
      element.removeEventListener('compositionstart', release)
      clearTimeout(timer)
      // A key-up missed while the chord offered nothing must not show a stale preview later.
      setHeld(false)
    }
  }, [root, enabled])

  useEffect(() => {
    // Only the composer showing a preview listens, so mounted chats add no work here.
    if (!held) {
      return
    }
    // macOS drops the Cmd key-up after Cmd+Tab, so leaving the window or tab also releases.
    const release = (): void => setHeld(false)
    const onHidden = (): void => {
      if (document.hidden) {
        release()
      }
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [held])

  const preview: NativeChatSteerChordPreview | null =
    !held || !alternateSend || pickerOpen
      ? null
      : hasDraft
        ? alternateSend
        : alternateSend === 'steer' && steerHead
          ? 'steer-queued'
          : null

  const runPreview = (): void => {
    if (preview === 'steer-queued') {
      steerHead?.()
    } else if (preview) {
      send({ alternate: true })
    }
  }
  return { preview, runPreview }
}
