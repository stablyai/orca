import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { NativeChatReplyRevealsContext } from './native-chat-reply-reveals'
import {
  advanceNativeChatText,
  arriveNativeChatText,
  NATIVE_CHAT_TEXT_REVEAL_DELAY_MS,
  type NativeChatTextReveal
} from './native-chat-text-reveal'

const WORD_FADE_MS = 300

export type NativeChatPacedText = { text: string; revealing: boolean; fading: boolean }

export function useNativeChatPacedText(
  rowKey: string,
  text: string,
  streaming: boolean
): NativeChatPacedText {
  const reducedMotion = usePrefersReducedMotion()
  const reveals = useContext(NativeChatReplyRevealsContext)
  const [initial] = useState<NativeChatTextReveal>(() => {
    const remembered = reveals?.drawn.get(rowKey)
    // Text received while unmounted has no arrival timestamp: show it without adding latency.
    if (remembered?.source === text && streaming) {
      return advanceNativeChatText(remembered, performance.now())
    }
    const shown = streaming && !remembered && reveals?.begun.has(rowKey) ? 0 : text.length
    return arriveNativeChatText(
      { source: text.slice(0, shown), shown, arrivals: [] },
      text,
      performance.now()
    )
  })
  const pace = useRef(initial)
  const [shown, setShown] = useState(initial.shown)
  const [grew, setGrew] = useState(initial.shown < text.length)

  useLayoutEffect(() => {
    const previous = pace.current
    const appended = text.startsWith(previous.source) && text.length > previous.source.length
    if (streaming && appended) {
      setGrew(true)
    }
    const immediate =
      reducedMotion || (!streaming && !appended && previous.shown === previous.source.length)
    pace.current = immediate
      ? { source: text, shown: text.length, arrivals: [] }
      : advanceNativeChatText(
          arriveNativeChatText(previous, text, performance.now()),
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
    let frame = 0
    let deadline = 0
    const tick = (): void => {
      cancelAnimationFrame(frame)
      window.clearTimeout(deadline)
      const now = performance.now()
      const next = advanceNativeChatText(pace.current, now)
      pace.current = next
      reveals?.drawn.set(rowKey, next)
      setShown(next.shown)
      if (next.shown >= next.source.length) {
        return
      }
      frame = requestAnimationFrame(tick)
      const earliest = Math.min(
        ...next.arrivals.map((arrival) => arrival.at + NATIVE_CHAT_TEXT_REVEAL_DELAY_MS)
      )
      deadline = window.setTimeout(tick, Math.max(0, earliest - now))
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(deadline)
    }
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
