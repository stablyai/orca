import { useEffect, useState, type RefObject } from 'react'
import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatComposerSendIntent } from './native-chat-composer-types'
import { isMacPlatform } from './native-chat-shortcut'

/** What Cmd/Ctrl+Enter would do now: the typed draft the other way, or the head queued card in. */
export type NativeChatSteerChordPreview = NativeChatFollowUpBehavior | 'steer-queued'

// Long enough that Cmd+C, Cmd+V and other quick chords never flash the button.
export const NATIVE_CHAT_STEER_CHORD_HOLD_MS = 150

/** While the chord's modifier is held alone in this composer, Send shows what Cmd/Ctrl+Enter would do. */
export function useNativeChatSteerChordPreview({
  root,
  alternateSend,
  hasDraft,
  steerHead,
  send,
  onSteerQueuedPreview
}: {
  root: RefObject<HTMLElement | null>
  /** The send's own resolver (`nativeChatComposerSendState`); undefined where the chord sends no differently. */
  alternateSend: NativeChatFollowUpBehavior | undefined
  hasDraft: boolean
  /** Present only while there is a head card to steer. */
  steerHead: (() => boolean) | undefined
  send: (intent?: NativeChatComposerSendIntent) => void
  /** Lets the queue mark the card a press would steer. */
  onSteerQueuedPreview?: (previewed: boolean) => void
}): { preview: NativeChatSteerChordPreview | null; runPreview: () => void } {
  const [held, setHeld] = useState(false)
  const enabled = alternateSend !== undefined
  useEffect(() => {
    const element = root.current
    if (!element || !enabled) {
      return
    }
    const chordKey = isMacPlatform() ? 'Meta' : 'Control'
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = (): void => {
      clearTimeout(timer)
      timer = undefined
      setHeld(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Any other key means a chord is under way (Enter included): it runs, the preview goes.
      if (event.key !== chordKey) {
        release()
        return
      }
      if (!event.repeat && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          setHeld(true)
        }, NATIVE_CHAT_STEER_CHORD_HOLD_MS)
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === chordKey) {
        release()
      }
    }
    // macOS drops the Cmd key-up after Cmd+Tab, so leaving the window or tab also releases.
    const onHidden = (): void => {
      if (document.hidden) {
        release()
      }
    }
    element.addEventListener('keydown', onKeyDown)
    element.addEventListener('keyup', onKeyUp)
    element.addEventListener('focusout', release)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      element.removeEventListener('keydown', onKeyDown)
      element.removeEventListener('keyup', onKeyUp)
      element.removeEventListener('focusout', release)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onHidden)
      // A key-up missed while the chord offered nothing must not show a stale preview later.
      release()
    }
  }, [root, enabled])

  const preview: NativeChatSteerChordPreview | null =
    !held || !alternateSend
      ? null
      : hasDraft
        ? alternateSend
        : alternateSend === 'steer' && steerHead
          ? 'steer-queued'
          : null

  const steerQueuedPreviewed = preview === 'steer-queued'
  useEffect(() => {
    if (!steerQueuedPreviewed) {
      return
    }
    // Why an effect: the preview derives from props as well as keys, so the queue follows it here.
    onSteerQueuedPreview?.(true)
    return () => onSteerQueuedPreview?.(false)
  }, [steerQueuedPreviewed, onSteerQueuedPreview])

  const runPreview = (): void => {
    if (preview === 'steer-queued') {
      steerHead?.()
    } else if (preview) {
      send({ alternate: true })
    }
  }
  return { preview, runPreview }
}
