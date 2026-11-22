import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  selectedFadingWords,
  watchDocumentRange
} from '@/components/comment-markdown/CommentMarkdownWords'
import type { MarkdownFadeHold } from '@/components/comment-markdown/comment-markdown-word-fade'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import {
  NativeChatHeldTextSessionContext,
  NativeChatReplyRevealsContext
} from './native-chat-reply-reveals'
import { documentHeldDrawnCount } from '../session/structured/read/document-viewer-visibility'
import {
  nativeChatRevealStepFrames,
  nativeChatTextAppended,
  playNativeChatTextRevealOnClock,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'

const WORD_FADE_MS = 300
/** A step that shows a long stretch at once (a slow-to-draw reply steps seconds apart) fades only
 *  its last words; one element per word across thousands of words would make each step slower. */
const FADE_MAX_CHARS = 1500

/** Reduced motion, or a reply redrawn whole, still steps on the clock, so slow replies back off,
 *  but each step shows all it has. */
const PLAIN_REVEAL_MS = 1

/** Text arrives every 60 ms; stepping faster would parse and draw the reply again between arrivals. */
const ARRIVAL_STEP_MS = 60
/** A reply that renders slowly (one long document) leaves most of the thread to typing and scrolling. */
const REVEAL_BUSY_SHARE = 1 / 10
/** A reply redrawn whole shows plainly, without per-word fades, so it may step more often. */
const WHOLE_REDRAW_BUSY_SHARE = 1 / 3

export type NativeChatPacedText = {
  text: string
  revealing: boolean
  fading: boolean
  /** Where the words shown in the last fade window start; text before it renders plain. */
  fadeFrom: number | undefined
  /** Selected fading words, which keep their elements so the selection keeps its nodes. */
  fadeHold: MarkdownFadeHold | undefined
  /** False once the reply steps plainly: held words keep their elements, but nothing animates. */
  fadeAnimates: boolean
}

type ShownSample = { at: number; length: number }
type Shown = { length: number; fadeFrom: number; hold?: MarkdownFadeHold }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
  /** The reply's element; only a selection of its fading words keeps them as elements. */
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
      performance.now(),
      reducedMotion ? PLAIN_REVEAL_MS : undefined
    )
  )
  // A reply redrawn whole steps plainly until it ends, so it doesn't switch back and forth.
  const [drawsWhole, setDrawsWhole] = useState(initial.drawsWhole === true)
  const revealMs = reducedMotion || drawsWhole ? PLAIN_REVEAL_MS : undefined
  const pace = useRef(initial)
  // Text already there when the reply mounts never fades.
  const samples = useRef<ShownSample[]>([{ at: -Infinity, length: initial.shown }])
  const [{ length: shown, fadeFrom, hold }, setShownState] = useState<Shown>({
    length: initial.shown,
    fadeFrom: initial.shown
  })
  // Recorded as text is shown, so only words shown in the last fade window are elements, plus any
  // selected ones, so the selection keeps its nodes.
  const [frames] = useState(() => {
    const clock = nativeChatRevealStepFrames(
      ARRIVAL_STEP_MS,
      REVEAL_BUSY_SHARE,
      WHOLE_REDRAW_BUSY_SHARE
    )
    if (initial.drawsWhole) {
      clock.drawWhole?.()
    }
    return clock
  })
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
      setShownState((previous) => {
        if (previous.length === length) {
          return previous
        }
        const selected = selectedFadingWords(root.current)
        const hold =
          selected?.from === previous.hold?.from && selected?.to === previous.hold?.to
            ? previous.hold
            : selected
        const fadeFrom = Math.max(Math.min(history[0]!.length, length), length - FADE_MAX_CHARS)
        return { length, fadeFrom, ...(hold ? { hold } : {}) }
      })
    },
    [root]
  )
  const [grew, setGrew] = useState(initial.shown < text.length)
  const heldTextSession = useContext(NativeChatHeldTextSessionContext)
  const heldDrawn = useRef(documentHeldDrawnCount(heldTextSession))

  useLayoutEffect(() => {
    const previous = pace.current
    if (streaming && nativeChatTextAppended(previous, text)) {
      setGrew(true)
    }
    // Text held while the window was hidden is drawn at once, without a fade.
    const caughtUp = heldDrawn.current !== documentHeldDrawnCount(heldTextSession)
    heldDrawn.current = documentHeldDrawnCount(heldTextSession)
    pace.current = receiveNativeChatText(
      previous,
      text,
      streaming,
      caughtUp,
      performance.now(),
      revealMs
    )
    // While text is still to reveal, only the frame clock steps it, so arrivals don't add renders.
    if (caughtUp || pace.current.shown >= text.length) {
      setShown(pace.current.shown, caughtUp)
    }
    reveals?.drawn.set(rowKey, pace.current)
  }, [text, streaming, revealMs, reveals, rowKey, setShown, heldTextSession])

  const behind = shown < text.length
  // The length on screen; a tick that holds a partial word renders nothing, so it is not timed.
  const onScreen = useRef(initial.shown)
  useLayoutEffect(() => {
    onScreen.current = shown
  }, [shown])
  useEffect(() => {
    if (!behind) {
      if (!streaming) {
        reveals?.drawn.delete(rowKey)
      }
      return
    }
    return playNativeChatTextRevealOnClock(
      () => pace.current,
      (next) => {
        pace.current = next
        reveals?.drawn.set(rowKey, next)
        if (next.shown === onScreen.current) {
          return
        }
        // Rendered here, so a step's cost is its own render and never the work queued before it.
        const startedAt = performance.now()
        flushSync(() => setShown(next.shown))
        frames.stepCost?.(performance.now() - startedAt)
        if (frames.redrawsWhole?.() && !pace.current.drawsWhole) {
          pace.current = { ...pace.current, drawsWhole: true }
          reveals?.drawn.set(rowKey, pace.current)
          setDrawsWhole(true)
        }
      },
      frames,
      revealMs
    )
  }, [behind, text, reveals, rowKey, streaming, setShown, frames, revealMs])
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
      if (due && selectedFadingWords(root.current) === undefined) {
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

  // Plain after the switch, except that selected words keep their elements until deselected.
  const fading = !reducedMotion && (revealing || lingering) && (!drawsWhole || hold !== undefined)
  useEffect(() => (fading ? watchDocumentRange() : undefined), [fading])
  return {
    text: text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading,
    fadeFrom: fading ? (drawsWhole ? shown : fadeFrom) : undefined,
    fadeHold: fading ? hold : undefined,
    fadeAnimates: !drawsWhole
  }
}
