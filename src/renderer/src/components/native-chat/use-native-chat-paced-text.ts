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
} from '../../../../shared/native-chat/transcript/native-chat-text-reveal'

const WORD_FADE_MS = 300

const FRAMES: NativeChatTextRevealFrames = {
  now: () => performance.now(),
  request: (step) => requestAnimationFrame(step),
  cancel: (frame) => cancelAnimationFrame(frame)
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(isDocumentHidden)
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const sync = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return hidden
}

export type NativeChatPacedText = { text: string; revealing: boolean; fading: boolean }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean
): NativeChatPacedText {
  const reducedMotion = usePrefersReducedMotion()
  const documentHidden = useDocumentHidden()
  const immediate = reducedMotion || documentHidden
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
    pace.current = receiveNativeChatText(previous, text, streaming, immediate, performance.now())
    setShown(pace.current.shown)
    reveals?.drawn.set(rowKey, pace.current)
  }, [text, streaming, immediate, reveals, rowKey])

  const behind = !immediate && shown < text.length
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

  const revealing = !immediate && ((streaming && grew) || behind)
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    if (immediate) {
      setLingering(false)
      return
    }
    if (revealing) {
      setLingering(true)
      return
    }
    const timer = setTimeout(() => setLingering(false), WORD_FADE_MS)
    return () => clearTimeout(timer)
  }, [immediate, revealing])

  return {
    text: immediate ? text : text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading: !immediate && (revealing || lingering)
  }
}
