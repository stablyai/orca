import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  isDocumentRangeInFadingWords,
  watchDocumentRange
} from '@/components/comment-markdown/CommentMarkdownWords'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { NativeChatReplyRevealsContext } from './native-chat-reply-reveals'
import { documentHeldDrawnCount } from '../session/structured/read/document-viewer-visibility'
import {
  nativeChatRevealStepFrames,
  nativeChatTextAppended,
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'

const WORD_FADE_MS = 300

/** Text arrives every 60 ms; stepping faster would parse and draw the reply again between arrivals. */
const ARRIVAL_STEP_MS = 60
/** A reply that renders slowly (one long document) leaves most of the thread to typing and scrolling. */
const REVEAL_BUSY_SHARE = 1 / 10

export type NativeChatPacedText = {
  text: string
  revealing: boolean
  fading: boolean
  /** Where the words shown in the last fade window start; text before it renders plain. */
  fadeFrom: number | undefined
}

type ShownSample = { at: number; length: number }
type Shown = { length: number; fadeFrom: number }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
  /** The reply's element; only a selection of its fading words holds them still. */
  root: React.RefObject<HTMLElement | null>
): NativeChatPacedText {
  const reducedMotion = usePrefersReducedMotion()
  const reveals = useContext(NativeChatReplyRevealsContext)
  const [initial] = useState<NativeChatTextReveal>(() =>
    startNativeChatTextReveal(
      text,
      streaming,
      reveals?.drawn.get(rowKey),
      reveals?.begun.has(rowKey) === true,
      performance.now()
    )
  )
  const pace = useRef(initial)
  // Text already there when the reply mounts never fades.
  const samples = useRef<ShownSample[]>([{ at: -Infinity, length: initial.shown }])
  const [{ length: shown, fadeFrom }, setShownState] = useState<Shown>({
    length: initial.shown,
    fadeFrom: initial.shown
  })
  // Recorded as text is shown, so only words shown in the last fade window are elements. Holds
  // still while its fading words are selected, so the selection keeps its nodes.
  const [frames] = useState(() => nativeChatRevealStepFrames(ARRIVAL_STEP_MS, REVEAL_BUSY_SHARE))
  const setShown = useCallback(
    (length: number, plain = false): void => {
      const now = performance.now()
      if (plain) {
        samples.current = [{ at: -Infinity, length }]
      }
      const history = samples.current
      history.push({ at: now, length })
      while (history.length > 1 && history[1]!.at <= now - WORD_FADE_MS) {
        history.shift()
      }
      setShownState((previous) =>
        previous.length === length
          ? previous
          : {
              length,
              fadeFrom: isDocumentRangeInFadingWords(root.current)
                ? previous.fadeFrom
                : Math.min(history[0]!.length, length)
            }
      )
    },
    [root]
  )
  const [grew, setGrew] = useState(initial.shown < text.length)
  const heldDrawn = useRef(documentHeldDrawnCount())

  useLayoutEffect(() => {
    const previous = pace.current
    if (streaming && nativeChatTextAppended(previous, text)) {
      setGrew(true)
    }
    // Text held while the window was hidden is drawn at once, without a fade.
    const caughtUp = heldDrawn.current !== documentHeldDrawnCount()
    heldDrawn.current = documentHeldDrawnCount()
    pace.current = receiveNativeChatText(
      previous,
      text,
      streaming,
      reducedMotion || caughtUp,
      performance.now()
    )
    // While text is still to reveal, only the frame clock steps it, so arrivals don't add renders.
    if (reducedMotion || caughtUp || pace.current.shown >= text.length) {
      setShown(pace.current.shown, caughtUp)
    }
    reveals?.drawn.set(rowKey, pace.current)
  }, [text, streaming, reducedMotion, reveals, rowKey, setShown])

  const behind = !reducedMotion && shown < text.length
  useEffect(() => {
    if (!behind) {
      if (!streaming) {
        reveals?.drawn.delete(rowKey)
      }
      return
    }
    return playNativeChatTextReveal(
      () => pace.current,
      (next) => {
        pace.current = next
        reveals?.drawn.set(rowKey, next)
        // Rendered here, so a step's cost is its own render and never the work queued before it.
        const startedAt = performance.now()
        flushSync(() => setShown(next.shown))
        frames.stepCost?.(performance.now() - startedAt)
      },
      frames
    )
  }, [behind, text, reveals, rowKey, streaming, setShown, frames])
  const revealing = !reducedMotion && ((streaming && grew) || behind)
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    if (revealing) {
      setLingering(true)
      return
    }
    let due = false
    // Dropping the word spans while text is selected would take the selection's nodes with them.
    const settle = (): void => {
      if (due && !isDocumentRangeInFadingWords(root.current)) {
        document.removeEventListener('selectionchange', settle)
        setLingering(false)
      }
    }
    document.addEventListener('selectionchange', settle)
    const timer = setTimeout(() => {
      due = true
      settle()
    }, WORD_FADE_MS)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', settle)
    }
  }, [revealing, root])

  const fading = !reducedMotion && (revealing || lingering)
  useEffect(() => (fading ? watchDocumentRange() : undefined), [fading])
  return {
    text: reducedMotion ? text : text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading,
    fadeFrom: fading ? fadeFrom : undefined
  }
}
