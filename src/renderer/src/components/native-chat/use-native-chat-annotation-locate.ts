import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import {
  resolveNativeChatAnnotationRange,
  type NativeChatAnnotationAnchor
} from './native-chat-annotation-anchor'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import {
  nativeChatSlotIndexOf,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

export function useNativeChatAnnotationReveal(
  slots: readonly NativeChatTranscriptSlot[],
  beginNavigation: () => void,
  readerLeavesEnd: () => void,
  requestRailJump: (item: { id: string }) => void
) {
  return useCallback(
    (messageId: string): boolean => {
      if (nativeChatSlotIndexOf(slots, messageId) < 0) {
        return false
      }
      beginNavigation()
      readerLeavesEnd()
      requestRailJump({ id: messageId })
      return true
    },
    [beginNavigation, readerLeavesEnd, requestRailJump, slots]
  )
}

export type NativeChatAnnotationNavigation = Pick<
  NativeChatMessageListHandle,
  'revealAnnotationMessage'
>

export function useNativeChatAnnotationLocate(
  rootRef: RefObject<HTMLElement | null>,
  scopeKey: string | undefined,
  enabled: boolean,
  messageListRef?: RefObject<NativeChatAnnotationNavigation | null>
) {
  const [missingScope, setMissingScope] = useState<string>()
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => cancelRef.current?.()
  }, [scopeKey, enabled])
  const locate = (anchor: NativeChatAnnotationAnchor): void => {
    cancelRef.current?.()
    setMissingScope(undefined)
    const root = rootRef.current
    if (!root || !enabled) {
      return
    }
    const reveal = (): boolean => {
      const range = resolveNativeChatAnnotationRange(root, anchor)
      const element = range?.startContainer.parentElement
      if (!element) {
        return false
      }
      element.scrollIntoView({ block: 'center', behavior: motionSafeScrollBehavior() })
      return true
    }
    const requested = messageListRef?.current?.revealAnnotationMessage?.(anchor.messageId)
    if (!requested && reveal()) {
      return
    }
    if (!requested) {
      setMissingScope(scopeKey)
      return
    }
    const observer = new MutationObserver(() => {
      if (reveal()) {
        cancel()
      }
    })
    const timeout = window.setTimeout(() => {
      cancel()
      setMissingScope(scopeKey)
    }, 2000)
    const frame = window.requestAnimationFrame(() => {
      if (reveal()) {
        cancel()
      }
    })
    const cancel = (): void => {
      observer.disconnect()
      window.clearTimeout(timeout)
      window.cancelAnimationFrame(frame)
      cancelRef.current = null
    }
    cancelRef.current = cancel
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }
  return {
    locate,
    missingOriginal: scopeKey !== undefined && missingScope === scopeKey,
    resetMissingOriginal: () => setMissingScope(undefined)
  }
}
