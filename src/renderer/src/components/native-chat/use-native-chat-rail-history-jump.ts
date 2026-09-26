// Jumping to a rail tick whose message is not loaded yet: page older history in
// until the message has a slot, then hand it to the ordinary rail jump.
//
// One awaited loop per jump, owning its own lifecycle. Each step reads the rail
// from a commit made after the last page landed, so "has a slot yet?" is always
// asked of what the list will actually render. It stops on anything but a page
// that moved the window, when the window passes the message without it drawing a
// row, after a bounded number of pages, or when aborted — by a later pick, any
// other navigation, reader input, a session switch or unmount.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

/** Far past any real session (pages are up to 200 journal items); only a
 *  runaway loop reaches it. */
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
  loadEarlier,
  jumpToLoaded
}: {
  items: readonly NativeChatRailItem[]
  /** A change abandons the jump: its target belongs to the previous session. */
  sessionKey: string
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

  // Every commit: the loop reads what the list last rendered, never a render in progress.
  useLayoutEffect(() => {
    committedRef.current = { items, loadEarlier, jumpToLoaded }
    const waiters = [...commitWaitersRef.current]
    commitWaitersRef.current.clear()
    for (const resolve of waiters) {
      resolve()
    }
  })

  // Forces a commit rather than waiting for one: the page may already have rendered
  // before its promise settled, and nothing else is owed a render after it.
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
        // Each pass reads a newer commit's rail, so there is no list to index up front.
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

  useEffect(() => abort, [abort, sessionKey])

  return { pendingId, start, abort }
}
