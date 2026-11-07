import { useNativeChatSelectedHistory } from './use-native-chat-selected-history'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'

/** Scroll intent holds the source's history, including while this mounted view is hidden. */
export function useNativeChatHistoryRetention({
  retainHistory,
  trimHistory,
  root,
  sourceKey,
  isVisible = true,
  initialHistoryAutoLoad = true
}: { root: React.RefObject<HTMLElement | null>; sourceKey: string; isVisible?: boolean } & Pick<
  NativeChatLiveSession,
  'retainHistory' | 'trimHistory' | 'initialHistoryAutoLoad'
>) {
  const { protectSelection, deferTrim, cancelTrim } = useNativeChatSelectedHistory({
    root,
    retainHistory,
    trimHistory,
    sourceKey,
    isVisible
  })
  const [history, setHistory] = useState<{
    sourceKey: string
    mode: 'initial' | 'browsing' | 'live'
  }>({ sourceKey, mode: 'initial' })
  const intent = useRef(history)
  const transition = useCallback(
    (mode: typeof history.mode) => {
      const current = intent.current
      if (current.sourceKey === sourceKey && current.mode === mode) {
        return
      }
      const next = { sourceKey, mode }
      intent.current = next
      setHistory(next)
    },
    [sourceKey]
  )
  const release = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      const held = release.current
      release.current = null
      if (held) {
        held()
        trimHistory?.()
      }
    },
    [retainHistory, trimHistory, sourceKey]
  )
  const leaveEnd = useCallback(() => {
    cancelTrim()
    transition('browsing')
    if (release.current == null) {
      release.current = retainHistory?.() ?? null
    }
  }, [retainHistory, cancelTrim, transition])
  const returnToEnd = useCallback(
    (reason?: 'send') => {
      const current = intent.current
      if (reason === 'send' && (current.sourceKey !== sourceKey || current.mode !== 'browsing')) {
        return
      }
      transition('live')
      const selected = protectSelection()
      const held = release.current
      release.current = null
      if (held) {
        held()
      }
      if (retainHistory || !selected) {
        trimHistory?.()
      }
      if (selected) {
        deferTrim()
      }
    },
    [retainHistory, trimHistory, protectSelection, deferTrim, sourceKey, transition]
  )
  return {
    leaveEnd,
    returnToEnd,
    autoLoadHistory:
      history.sourceKey === sourceKey && history.mode !== 'initial'
        ? history.mode === 'browsing'
        : initialHistoryAutoLoad
  }
}
