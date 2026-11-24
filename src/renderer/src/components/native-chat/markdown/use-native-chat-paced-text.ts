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
  NativeChatReplyRevealsContext,
  NativeChatSaveFallbackContext
} from './native-chat-reply-reveals'
import {
  documentHeldDrawnCount,
  documentRowShowsSavesOnly,
  documentRowStreams
} from '../session/structured/read/document-viewer-visibility'
import {
  nativeChatTextAppended,
  playNativeChatTextRevealOnClock,
  receiveNativeChatText,
  startNativeChatTextReveal,
  nativeChatSaveRevealMs,
  nativeChatSaveStepMs,
  type NativeChatTextReveal
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'
import { createNativeChatRevealScheduler } from '../../../../../shared/native-chat/transcript/row-content/native-chat-reveal-scheduler'

const WORD_FADE_MS = 300
/** A step that shows a long stretch at once (a slow-to-draw reply steps seconds apart) fades only
 *  its last words; one element per word across thousands of words would make each step slower. */
const FADE_MAX_CHARS = 1500

/** Reduced motion still steps on the clock, so slow replies back off, but each step shows all it has. */
const PLAIN_REVEAL_MS = 1

/** Text arrives every 60 ms; stepping faster would parse and draw the reply again between arrivals. */
const ARRIVAL_STEP_MS = 60
/** A reply that renders slowly leaves most of the thread to typing and scrolling. Until a reply
 *  switches to its saves (a 100 ms step), steps stay under 0.4 s apart, so none is a visible pause. */
const REVEAL_BUSY_SHARE = 1 / 4
/** A key or click already waiting for the main thread, where the browser can tell (Chromium). */
function documentInputPending(): boolean {
  if (typeof navigator === 'undefined' || !('scheduling' in navigator)) {
    return false
  }
  const { scheduling } = navigator
  return (
    typeof scheduling === 'object' &&
    scheduling !== null &&
    'isInputPending' in scheduling &&
    typeof scheduling.isInputPending === 'function' &&
    scheduling.isInputPending() === true
  )
}

/** Every streaming reply in the window steps on one clock and shares that one busy share. */
const revealFrames = createNativeChatRevealScheduler(
  ARRIVAL_STEP_MS,
  REVEAL_BUSY_SHARE,
  documentInputPending
)

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
  rowRevision?: number
): NativeChatPacedText {
  // Only a row whose saves follow its growth can fall back to them.
  const savedRevision = useContext(NativeChatSaveFallbackContext) ? rowRevision : undefined
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
  // Only a row with saves to show can wait for them.
  const [drawsWhole, setDrawsWhole] = useState(
    initial.drawsWhole === true && savedRevision !== undefined
  )
  // The text as of the reply's last save; state, so a save renders the reveal that shows it.
  // A remount keeps the save it was revealing; a save made while unmounted is taken in its effect.
  const [firstSave] = useState(() => ({
    revision: drawsWhole ? initial.savedAt : savedRevision,
    text: drawsWhole ? initial.source : text
  }))
  const saved = useRef(firstSave)
  const [savedState, setSavedState] = useState(firstSave)
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
  const [frames] = useState(revealFrames)
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
  // When the last save came and how long after the one before it.
  const lastSave = useRef<{ at: number; gap?: number }>(undefined)
  const drawnAt = useRef(-Infinity)
  const spreadsSaves = drawsWhole && streaming && !reducedMotion
  // A drawn streaming reply keeps its chat's live text unless it, and every other, shows saves only.
  useEffect(
    () =>
      streaming && heldTextSession !== undefined
        ? documentRowStreams(heldTextSession, rowKey)
        : undefined,
    [streaming, heldTextSession, rowKey]
  )
  // Drawn only at its saves, the reply's chat stops taking live text until the reply ends.
  useEffect(
    () =>
      drawsWhole && streaming && heldTextSession !== undefined
        ? documentRowShowsSavesOnly(heldTextSession, rowKey)
        : undefined,
    [drawsWhole, streaming, heldTextSession, rowKey]
  )

  useLayoutEffect(() => {
    const previous = pace.current
    if (streaming && nativeChatTextAppended(previous, text)) {
      setGrew(true)
    }
    // Text held while the window was hidden is drawn at once, without a fade.
    const caughtUp = heldDrawn.current !== documentHeldDrawnCount(heldTextSession)
    heldDrawn.current = documentHeldDrawnCount(heldTextSession)
    // A reply showing only its saves keeps the last one through a catch-up; its next save shows more.
    if (!streaming || (caughtUp && !drawsWhole) || saved.current.revision !== savedRevision) {
      if (streaming && saved.current.revision !== savedRevision) {
        const at = performance.now()
        lastSave.current = { at, gap: lastSave.current && at - lastSave.current.at }
      }
      saved.current = { revision: savedRevision, text }
      if (drawsWhole) {
        setSavedState((held) =>
          held.revision === savedRevision && held.text === text ? held : saved.current
        )
      }
    }
    const source = drawsWhole ? saved.current.text : text
    pace.current = receiveNativeChatText(
      previous,
      source,
      streaming,
      // A save shown on catch-up is still revealed as main reveals it.
      drawsWhole ? reducedMotion : caughtUp,
      performance.now(),
      (spreadsSaves && nativeChatSaveRevealMs(lastSave.current?.gap)) || revealMs
    )
    if (drawsWhole) {
      pace.current = { ...pace.current, savedAt: saved.current.revision }
    }
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
    savedRevision,
    spreadsSaves
  ])

  // A save, or the turn's end, is the reveal's source in the render that brings it, as main's
  // text is; a render later, the reveal would stop and start again around the turn's end.
  const savedSource = savedRevision !== savedState.revision || !streaming ? text : savedState.text
  const source = drawsWhole ? savedSource : text
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
    return playNativeChatTextRevealOnClock(
      () => pace.current,
      (next) => {
        const now = performance.now()
        if (spreadsSaves && now - drawnAt.current < nativeChatSaveStepMs(lastSave.current?.gap)) {
          return false
        }
        pace.current = next
        reveals?.drawn.set(rowKey, next)
        if (next.shown === onScreen.current) {
          return true
        }
        drawnAt.current = now
        // Rendered here, so a step's cost is its own render and never the work queued before it.
        const startedAt = performance.now()
        flushSync(() => setShown(next.shown, drawsWhole))
        frames.stepCost?.(performance.now() - startedAt)
        if (savedRevision !== undefined && frames.redrawsWhole?.() && !pace.current.drawsWhole) {
          // From here it shows each save as main does, finishing the reveal of the one it has.
          const onScreenText = pace.current.source.slice(0, next.shown)
          const save = saved.current.revision === savedRevision ? saved.current.text : ''
          const source =
            save.length > onScreenText.length && save.startsWith(onScreenText) ? save : onScreenText
          saved.current = { revision: savedRevision, text: source }
          setSavedState(saved.current)
          pace.current = {
            source,
            shown: next.shown,
            arrivals:
              source.length > next.shown
                ? [{ from: next.shown, to: source.length, at: performance.now() }]
                : [],
            drawsWhole: true,
            savedAt: savedRevision
          }
          reveals?.drawn.set(rowKey, pace.current)
          setDrawsWhole(true)
        }
        return true
      },
      frames,
      // Shown at its saves, a reply reveals each across the gap before it, so text keeps moving.
      (spreadsSaves && nativeChatSaveRevealMs(lastSave.current?.gap)) || revealMs
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
    savedRevision,
    spreadsSaves
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
