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
  playNativeChatTextReveal,
  playNativeChatTextRevealOnClock,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal,
  type NativeChatTextRevealFrames
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'

const WORD_FADE_MS = 300
/** A step that shows a long stretch at once (a slow-to-draw reply steps seconds apart) fades only
 *  its last words; one element per word across thousands of words would make each step slower. */
const FADE_MAX_CHARS = 1500

/** Reduced motion still steps on the clock, so slow replies back off, but each step shows all it has. */
const PLAIN_REVEAL_MS = 1

/** The display's own frames, as main reveals each save, for a reply redrawn whole. */
const ANIMATION_FRAMES: NativeChatTextRevealFrames = {
  now: () => performance.now(),
  request: (step) => requestAnimationFrame(step),
  cancel: (frame) => cancelAnimationFrame(frame)
}

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
  /** Selected fading words, which keep their elements so the selection keeps its nodes. */
  fadeHold: MarkdownFadeHold | undefined
  /** False once the reply shows only its saves: held words keep their elements, but nothing animates. */
  fadeAnimates: boolean
}

type ShownSample = { at: number; length: number }
type Shown = { length: number; fadeFrom: number; hold?: MarkdownFadeHold }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
  /** The reply's element; only a selection of its fading words keeps them as elements. */
  root: React.RefObject<HTMLElement | null>,
  /** The row's saved journal revision: a save bumps it, live text keeps it. */
  savedRevision?: number
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
  // A reply redrawn whole is shown as main shows it until it ends, so it doesn't switch back and
  // forth: only the text of each save, revealed by main's own reveal.
  const [drawsWhole, setDrawsWhole] = useState(initial.drawsWhole === true)
  // The text as of the reply's last save; state, so a save renders the reveal that shows it.
  const saved = useRef({ revision: savedRevision, text: text.slice(0, initial.shown) })
  const [savedText, setSavedText] = useState(saved.current.text)
  const revealMs = reducedMotion && !drawsWhole ? PLAIN_REVEAL_MS : undefined
  const pace = useRef(initial)
  // Text already there when the reply mounts never fades.
  const samples = useRef<ShownSample[]>([{ at: -Infinity, length: initial.shown }])
  const [{ length: shown, fadeFrom, hold }, setShownState] = useState<Shown>({
    length: initial.shown,
    fadeFrom: initial.shown
  })
  // Recorded as text is shown, so only words shown in the last fade window are elements, plus any
  // selected ones, so the selection keeps its nodes.
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
    if (!streaming || caughtUp || saved.current.revision !== savedRevision) {
      saved.current = { revision: savedRevision, text }
      setSavedText(text)
    }
    const source = drawsWhole ? saved.current.text : text
    pace.current = receiveNativeChatText(
      previous,
      source,
      streaming,
      caughtUp || (drawsWhole && reducedMotion),
      performance.now(),
      revealMs
    )
    // While text is still to reveal, only the reveal steps it, so arrivals don't add renders.
    if (caughtUp || pace.current.shown >= source.length) {
      setShown(pace.current.shown, caughtUp || drawsWhole)
    }
    reveals?.drawn.set(rowKey, pace.current)
  }, [
    text,
    streaming,
    revealMs,
    reveals,
    rowKey,
    setShown,
    heldTextSession,
    drawsWhole,
    reducedMotion,
    savedRevision
  ])

  const source = drawsWhole ? savedText : text
  const behind = shown < source.length
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
    if (drawsWhole) {
      // Main's own reveal of each save, on every display frame.
      return playNativeChatTextReveal(
        () => pace.current,
        (next) => {
          pace.current = next
          reveals?.drawn.set(rowKey, next)
          setShown(next.shown, true)
        },
        ANIMATION_FRAMES
      )
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
          // From here it shows what is on screen, then each save as main does.
          const onScreenText = pace.current.source.slice(0, next.shown)
          saved.current = { revision: savedRevision, text: onScreenText }
          setSavedText(onScreenText)
          pace.current = { source: onScreenText, shown: next.shown, arrivals: [], drawsWhole: true }
          reveals?.drawn.set(rowKey, pace.current)
          setDrawsWhole(true)
        }
      },
      frames,
      revealMs
    )
  }, [
    behind,
    source,
    reveals,
    rowKey,
    streaming,
    setShown,
    frames,
    revealMs,
    drawsWhole,
    savedRevision
  ])
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
    text: source.slice(0, Math.min(shown, source.length)),
    revealing,
    fading,
    fadeFrom: fading ? (drawsWhole ? shown : fadeFrom) : undefined,
    fadeHold: fading ? hold : undefined,
    fadeAnimates: !drawsWhole
  }
}
