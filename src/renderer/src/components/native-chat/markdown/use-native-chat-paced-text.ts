import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  // Text already there when the reply mounts never fades.
  const samples = useRef<ShownSample[]>([{ at: -Infinity, length: initial.shown }])
  const [{ length: shown, fadeFrom }, setShownState] = useState<Shown>({
    length: initial.shown,
    fadeFrom: initial.shown
  })
  // Recorded as text is shown, so only words shown in the last fade window are elements. Holds
  // still while a range is selected, so the selection keeps its nodes.
  const setShown = useCallback((length: number): void => {
    const now = performance.now()
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
            fadeFrom: isDocumentRangeSelected()
              ? previous.fadeFrom
              : Math.min(history[0]!.length, length)
          }
    )
  }, [])
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
        setShown(next.shown)
      },
      FRAMES
    )
  }, [behind, text, reveals, rowKey, streaming, setShown])

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

  const fading = !reducedMotion && (revealing || lingering)
  useEffect(() => (fading ? watchDocumentRange() : undefined), [fading])
  return {
    text: reducedMotion ? text : text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading,
    fadeFrom: fading ? fadeFrom : undefined
  }
}
