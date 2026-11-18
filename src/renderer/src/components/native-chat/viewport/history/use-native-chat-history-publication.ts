import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isCurrentPlatformIosWeb } from '@/app-shell/platform/ios-web-platform'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatPrependAnchor } from '../virtualization/NativeChatPrependSnapshot'

type PublishedHistory = {
  slots: readonly NativeChatTranscriptSlot[]
  loadingEarlier: boolean
  showOlderHistory: boolean
  anchor: NativeChatPrependAnchor
}

/** WebKit defers native anchor writes during momentum; publish this view's prefix after it ends. */
export function useNativeChatHistoryPublication({
  slots,
  session,
  pagesHistory,
  isVisible,
  scrollRef
}: {
  slots: readonly NativeChatTranscriptSlot[]
  session: Pick<
    NativeChatLiveSession,
    | 'agent'
    | 'sessionId'
    | 'olderHistoryGeneration'
    | 'prependRevision'
    | 'hasMore'
    | 'loadingEarlier'
    | 'readPhase'
  >
  /** The scope pages history (a subagent's view does not). */
  pagesHistory: boolean
  isVisible: boolean
  scrollRef: React.RefObject<HTMLElement | null>
}): PublishedHistory {
  const revision = session.prependRevision ?? 0
  const sourceKey = `${session.agent}:${session.sessionId}:${session.olderHistoryGeneration}`
  const moving = useRef(false)
  const committed = useRef({ slots, revision, sourceKey })
  const [, publishIdle] = useState(0)
  const ios = isCurrentPlatformIosWeb()

  useEffect(() => {
    const root = scrollRef.current
    if (!ios || !root || !isVisible) {
      moving.current = false
      return
    }
    let touching = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (!touching) {
        moving.current = false
        publishIdle((value) => value + 1)
      }
    }
    const settle = () => {
      clearTimeout(timer)
      timer = setTimeout(finish, 150)
    }
    const scroll = (event: Event) => {
      if (event.target === root) {
        moving.current = true
        settle()
      }
    }
    const touch = () => {
      touching = true
      moving.current = true
      clearTimeout(timer)
    }
    const release = () => {
      touching = false
      settle()
    }
    root.addEventListener('scroll', scroll, { passive: true })
    root.addEventListener('scrollend', finish)
    root.addEventListener('touchstart', touch, { passive: true })
    root.addEventListener('touchend', release, { passive: true })
    root.addEventListener('touchcancel', release, { passive: true })
    return () => {
      clearTimeout(timer)
      root.removeEventListener('scroll', scroll)
      root.removeEventListener('scrollend', finish)
      root.removeEventListener('touchstart', touch)
      root.removeEventListener('touchend', release)
      root.removeEventListener('touchcancel', release)
      moving.current = false
    }
  }, [ios, isVisible, scrollRef])

  const held =
    ios &&
    isVisible &&
    moving.current &&
    sourceKey === committed.current.sourceKey &&
    revision !== committed.current.revision
  const published = held ? committed.current : { slots, revision, sourceKey }
  useLayoutEffect(() => {
    committed.current = published
  })
  const loadingEarlier = session.loadingEarlier || held
  return {
    slots: published.slots,
    // A held page keeps the loading row and blocks further auto-loads until it publishes.
    loadingEarlier,
    // Pending/failed reads cannot page; recovery remounts the sentinel to recheck its range.
    showOlderHistory: (session.hasMore || held) && session.readPhase === 'ready' && pagesHistory,
    anchor: { sourceKey, prependRevision: published.revision, isVisible }
  }
}
