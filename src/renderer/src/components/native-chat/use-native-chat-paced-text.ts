import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { NativeChatReplyRevealsContext } from './native-chat-reply-reveals'
import {
  nativeChatTextAppended,
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal,
  type NativeChatTextRevealFrames
} from '../../../../shared/native-chat-text-reveal'

const WORD_FADE_MS = 300

const FRAMES: NativeChatTextRevealFrames = {
  now: () => performance.now(),
  request: (step) => requestAnimationFrame(step),
  cancel: (frame) => cancelAnimationFrame(frame)
}

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
