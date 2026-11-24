import type * as React from 'react'
import type { NativeChatFollowUpBehavior } from './native-chat-follow-up-behavior'

/** What Cmd/Ctrl+Enter would do now: the typed draft the other way, or the head queued card in. */
export type NativeChatSteerChordPreview = NativeChatFollowUpBehavior | 'steer-queued'

// Long enough that Cmd+C, Cmd+V and other quick chords never flash the button.
export const NATIVE_CHAT_STEER_CHORD_HOLD_MS = 150

/** Built with the caller's own React: desktop and the phone bundle each resolve a different copy. */
export function createNativeChatSteerChordPreviewHook({
  useEffect,
  useState
}: Pick<typeof React, 'useEffect' | 'useState'>) {
  return useNativeChatSteerChordPreview

  /** While the chord's modifier is held alone in this composer, Send shows what Cmd/Ctrl+Enter would do. */
  function useNativeChatSteerChordPreview(
    /** The composer's DOM element; anything else (a native view) previews nothing. */
    root: React.RefObject<unknown>,
    /** The send's own resolver: `alternateSend` is undefined where the chord sends no differently. */
    {
      alternateSend,
      hasDraft,
      chordSteersHead
    }: {
      alternateSend?: NativeChatFollowUpBehavior
      hasDraft: boolean
      /** On an empty composer the chord sends the head card now (the keydown's own flag). */
      chordSteersHead: boolean
    },
    /** Present only while there is a head card to steer. */
    steerHead: (() => unknown) | undefined,
    sendAlternate: () => void,
    /** An open picker takes Enter, so the chord previews nothing then. */
    pickerOpen: boolean,
    /** The chord's own modifier: Meta where Cmd+Enter sends, Control where Ctrl+Enter does. */
    chordKey: 'Meta' | 'Control'
  ): { preview: NativeChatSteerChordPreview | null; runPreview: () => void } {
    // 'down' while the modifier is pressed alone and the delay runs; 'held' once it has passed.
    const [chord, setChord] = useState<'up' | 'down' | 'held'>('up')
    const held = chord === 'held'
    const steersHead = chordSteersHead && steerHead !== undefined
    const enabled = alternateSend !== undefined || steersHead
    useEffect(() => {
      const element = root.current
      if (!(element instanceof HTMLElement) || !enabled) {
        return
      }
      const mac = chordKey === 'Meta'
      const release = (): void => setChord('up')
      const onKeyDown = (event: KeyboardEvent): void => {
        // Any other key means a chord is under way (Enter included): it runs, the preview goes.
        // During IME composition the IME owns Enter, so the chord previews nothing either.
        // Shift or Alt already down makes it another chord (Shift steers the head card whatever is typed).
        const otherModifier =
          event.shiftKey || event.altKey || (mac ? event.ctrlKey : event.metaKey)
        if (event.key !== chordKey || event.isComposing || otherModifier) {
          release()
        } else if (!event.repeat) {
          setChord((current) => (current === 'up' ? 'down' : current))
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
        // A key-up missed while the chord offered nothing must not show a stale preview later.
        release()
      }
    }, [root, enabled, chordKey])

    useEffect(() => {
      if (chord !== 'down') {
        return
      }
      const timer = setTimeout(() => {
        // Cmd+Tab inside the delay leaves the window before the preview would show.
        setChord(document.hasFocus() ? 'held' : 'up')
      }, NATIVE_CHAT_STEER_CHORD_HOLD_MS)
      return () => clearTimeout(timer)
    }, [chord])

    useEffect(() => {
      // Only the composer showing a preview listens, so mounted chats add no work here.
      if (!held) {
        return
      }
      // macOS drops the Cmd key-up after Cmd+Tab, so leaving the window or tab also releases.
      const release = (): void => setChord('up')
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
      !held || pickerOpen
        ? null
        : hasDraft
          ? (alternateSend ?? null)
          : steersHead
            ? 'steer-queued'
            : null

    const runPreview = (): void => {
      if (preview === 'steer-queued') {
        steerHead?.()
      } else if (preview) {
        sendAlternate()
      }
    }
    return { preview, runPreview }
  }
}
