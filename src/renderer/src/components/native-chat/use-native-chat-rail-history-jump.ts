// Jumping to a rail tick whose message is not loaded yet: page older history in
// until the message has a slot, then hand it to the ordinary rail jump. Jumping
// to the start of the conversation is the same walk, with no older page as its target.
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

const HISTORY_START = Symbol('history-start')
type HistoryJumpTarget = string | typeof HISTORY_START

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
  jumpToLoaded,
  jumpToStart
}: {
  items: readonly NativeChatRailItem[]
  /** A change abandons the jump: its target belongs to the previous session. */
  sessionKey: string
  /** Hiding the pane abandons the jump too: a hidden lane stops reading, so a page never lands. */
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  jumpToLoaded: (item: NativeChatRailItem) => void
  /** Called once no older page is left, or none can be read: the top of what loaded. */
  jumpToStart: () => void
}): {
  pendingId: string | null
  startPending: boolean
  start: (item: NativeChatRailItem) => void
  startFromBeginning: () => void
  abort: () => void
} {
  const [pending, setPending] = useState<HistoryJumpTarget | null>(null)
  const [, requestCommit] = useReducer((count: number) => count + 1, 0)
  const controllerRef = useRef<AbortController | null>(null)
  const committedRef = useRef({ items, loadEarlier, jumpToLoaded, jumpToStart })
  const commitWaitersRef = useRef(new Set<() => void>())

  // Every commit: the loop reads what the list last rendered, never a render in progress.
  useLayoutEffect(() => {
    committedRef.current = { items, loadEarlier, jumpToLoaded, jumpToStart }
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
    async (target: HistoryJumpTarget, signal: AbortSignal): Promise<void> => {
      for (let pages = 0; ; pages += 1) {
        if (target !== HISTORY_START) {
          // Each pass reads a newer commit's rail, so there is no list to index up front.
          const item = railItemById(committedRef.current.items, target)
          if (!item) {
            return
          }
          if (item.slotIndex !== null) {
            committedRef.current.jumpToLoaded(item)
            return
          }
        }
        if (pages >= NATIVE_CHAT_RAIL_JUMP_MAX_PAGES) {
          return
        }
        const result = await committedRef.current.loadEarlier()
        if (signal.aborted) {
          return
        }
        // A page that cannot be read still leaves the reader asking for the top of what loaded.
        if (target === HISTORY_START && result !== 'applied' && result !== 'superseded') {
          committedRef.current.jumpToStart()
          return
        }
        if (result !== 'applied') {
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
    setPending(null)
  }, [])

  // The latest pick wins; a page the previous jump started is joined, not repeated.
  const begin = useCallback(
    (target: HistoryJumpTarget) => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setPending(target)
      void run(target, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null
            setPending(null)
          }
        })
    },
    [run]
  )
  const start = useCallback((item: NativeChatRailItem) => begin(item.id), [begin])
  const startFromBeginning = useCallback(() => begin(HISTORY_START), [begin])

  useEffect(() => abort, [abort, sessionKey, isVisible])

  return {
    pendingId: typeof pending === 'string' ? pending : null,
    startPending: pending === HISTORY_START,
    start,
    startFromBeginning,
    abort
  }
}
