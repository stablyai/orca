// Page until the target renders, checking committed slots after each page; stop on no progress, omission, page bound or aborted navigation.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

/** Bound runaway paging beyond any expected session size. */
export const NATIVE_CHAT_RAIL_JUMP_MAX_PAGES = 1000

function railItemById(
  items: readonly NativeChatRailItem[],
  id: string
): NativeChatRailItem | undefined {
  return items.find((item) => item.id === id)
}

export function useNativeChatRailHistoryJump({
  items,
  sessionKey,
  isVisible,
  loadEarlier,
  jumpToLoaded
}: {
  items: readonly NativeChatRailItem[]
  /** A change abandons the jump: its target belongs to the previous session. */
  sessionKey: string
  /** Hiding the pane abandons the jump too: a hidden lane stops reading, so a page never lands. */
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  jumpToLoaded: (item: NativeChatRailItem) => void
}): {
  pendingId: string | null
  start: (item: NativeChatRailItem) => void
  abort: () => void
} {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [, requestCommit] = useReducer((count: number) => count + 1, 0)
  const controllerRef = useRef<AbortController | null>(null)
  const committedRef = useRef({ items, loadEarlier, jumpToLoaded })
  const commitWaitersRef = useRef(new Set<() => void>())

  // Read committed rails; in-progress renders may be discarded.
  useLayoutEffect(() => {
    committedRef.current = { items, loadEarlier, jumpToLoaded }
    const waiters = [...commitWaitersRef.current]
    commitWaitersRef.current.clear()
    for (const resolve of waiters) {
      resolve()
    }
  })

  // Force a commit because the page may have rendered before resolving, with no further render scheduled.
  const nextCommit = useCallback((signal: AbortSignal): Promise<void> => {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        commitWaitersRef.current.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      commitWaitersRef.current.add(done)
      signal.addEventListener('abort', done)
      requestCommit()
    })
  }, [])

  const run = useCallback(
    async (id: string, signal: AbortSignal): Promise<void> => {
      for (let pages = 0; ; pages += 1) {
        const target = railItemById(committedRef.current.items, id)
        if (!target) {
          return
        }
        if (target.slotIndex !== null) {
          committedRef.current.jumpToLoaded(target)
          return
        }
        if (pages >= NATIVE_CHAT_RAIL_JUMP_MAX_PAGES) {
          return
        }
        const result = await committedRef.current.loadEarlier()
        if (signal.aborted || result !== 'applied') {
          return
        }
        await nextCommit(signal)
        if (signal.aborted) {
          return
        }
      }
    },
    [nextCommit]
  )

  const abort = useCallback(() => {
    const controller = controllerRef.current
    if (!controller) {
      return
    }
    controllerRef.current = null
    controller.abort()
    setPendingId(null)
  }, [])

  // The latest pick wins; a page the previous jump started is joined, not repeated.
  const start = useCallback(
    (item: NativeChatRailItem) => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setPendingId(item.id)
      void run(item.id, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null
            setPendingId(null)
          }
        })
    },
    [run]
  )

  useEffect(() => abort, [abort, sessionKey, isVisible])

  return { pendingId, start, abort }
}
