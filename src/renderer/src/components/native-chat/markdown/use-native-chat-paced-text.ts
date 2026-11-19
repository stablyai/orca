import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isDocumentRangeSelected,
  watchDocumentRange
} from '@/components/comment-markdown/CommentMarkdownWords'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { NativeChatReplyRevealsContext } from './native-chat-reply-reveals'
import {
  NATIVE_CHAT_REVEAL_STEP_FRAMES,
  nativeChatTextAppended,
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal
} from '../../../../../shared/native-chat/transcript/row-content/native-chat-text-reveal'

const WORD_FADE_MS = 300

const FRAMES = NATIVE_CHAT_REVEAL_STEP_FRAMES

export type NativeChatPacedText = { text: string; revealing: boolean; fading: boolean }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean
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
  const [shown, setShown] = useState(initial.shown)
  const [grew, setGrew] = useState(initial.shown < text.length)

  useLayoutEffect(() => {
    const previous = pace.current
    if (streaming && nativeChatTextAppended(previous, text)) {
      setGrew(true)
    }
    pace.current = receiveNativeChatText(
      previous,
      text,
      streaming,
      reducedMotion,
      performance.now()
    )
    setShown(pace.current.shown)
    reveals?.drawn.set(rowKey, pace.current)
  }, [text, streaming, reducedMotion, reveals, rowKey])

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
        setShown(next.shown)
      },
      FRAMES
    )
  }, [behind, text, reveals, rowKey, streaming])

  const revealing = !reducedMotion && ((streaming && grew) || behind)
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    if (revealing) {
      setLingering(true)
      return
    }
    const timer = setTimeout(() => setLingering(false), WORD_FADE_MS)
    return () => clearTimeout(timer)
  }, [revealing])

  return {
    text: reducedMotion ? text : text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading: !reducedMotion && (revealing || lingering)
  }
}

type DrawnSample = { at: number; length: number }

/** Where the words drawn in the last fade window start: text drawn before it stays plain, so only
 *  arriving words are elements. Holds still while a range is selected, so the selection keeps its
 *  nodes. */
export function useNativeChatFadeWindow(drawn: string, fading: boolean): number | undefined {
  // Text already there when the reply mounts never fades.
  const [samples] = useState<DrawnSample[]>(() => [{ at: -Infinity, length: drawn.length }])
  const held = useRef(drawn.length)
  useLayoutEffect(() => {
    const now = performance.now()
    samples.push({ at: now, length: drawn.length })
    while (samples.length > 1 && samples[1]!.at <= now - WORD_FADE_MS) {
      samples.shift()
    }
  }, [drawn, samples])
  useEffect(() => (fading ? watchDocumentRange() : undefined), [fading])
  if (!fading) {
    return undefined
  }
  if (isDocumentRangeSelected()) {
    return held.current
  }
  const cutoff = performance.now() - WORD_FADE_MS
  let from = samples[0]!.length
  for (const sample of samples) {
    if (sample.at <= cutoff) {
      from = sample.length
    }
  }
  held.current = Math.min(from, drawn.length)
  return held.current
}
