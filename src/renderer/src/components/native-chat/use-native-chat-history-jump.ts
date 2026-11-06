// Page until the target renders, checking committed state after each page; stop on no progress, omission, page bound or aborted navigation.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'

/** Bound runaway paging beyond any expected session size. */
export const NATIVE_CHAT_HISTORY_JUMP_MAX_PAGES = 1000

/** A rail pick, or a subagent named from outside the transcript (the agents strip). */
export type NativeChatHistoryJumpTarget =
  | { kind: 'rail'; id: string }
  | { kind: 'subagent'; agentId: string }

/**
 * What the committed transcript can do for a target now: it landed, it needs older history,
 * it needs one more commit (a disclosure the step just opened), or it cannot be reached.
 * `waited` counts the commits waited since the last page, so a step opens once, then lands.
 */
export type NativeChatHistoryJumpStep = (
  target: NativeChatHistoryJumpTarget,
  waited: number
) => 'landed' | 'page' | 'commit' | 'stop'

/** A rail pick lands once its message has a slot; an omitted one stops. */
export function nativeChatRailJumpStep(
  items: readonly NativeChatRailItem[],
  id: string,
  jumpToLoaded: (item: NativeChatRailItem) => void
): ReturnType<NativeChatHistoryJumpStep> {
  const target = items.find((item) => item.id === id)
  if (!target) {
    return 'stop'
  }
  if (target.slotIndex === null) {
    return 'page'
  }
  jumpToLoaded(target)
  return 'landed'
}

export function useNativeChatHistoryJump({
  step,
  sessionKey,
  isVisible,
  loadEarlier
}: {
  step: NativeChatHistoryJumpStep
  /** A change abandons the jump: its target belongs to the previous session. */
  sessionKey: string
  /** Hiding the pane abandons the jump too: a hidden lane stops reading, so a page never lands. */
  isVisible: boolean
  loadEarlier: () => Promise<NativeChatOlderPageResult>
}): {
  pending: NativeChatHistoryJumpTarget | null
  start: (target: NativeChatHistoryJumpTarget) => void
  abort: () => void
} {
  const [pending, setPending] = useState<NativeChatHistoryJumpTarget | null>(null)
  const [, requestCommit] = useReducer((count: number) => count + 1, 0)
  const controllerRef = useRef<AbortController | null>(null)
  const committedRef = useRef({ step, loadEarlier })
  const commitWaitersRef = useRef(new Set<() => void>())

  // Read committed state; in-progress renders may be discarded.
  useLayoutEffect(() => {
    committedRef.current = { step, loadEarlier }
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
    async (target: NativeChatHistoryJumpTarget, signal: AbortSignal): Promise<void> => {
      let waited = 0
      for (let pages = 0; ;) {
        const next = committedRef.current.step(target, waited)
        if (next === 'landed' || next === 'stop') {
          return
        }
        if (next === 'commit') {
          // A disclosure opens once; a target still missing after its commit is not coming.
          if (waited > 0) {
            return
          }
          waited += 1
        } else {
          if (pages >= NATIVE_CHAT_HISTORY_JUMP_MAX_PAGES) {
            return
          }
          pages += 1
          waited = 0
          const result = await committedRef.current.loadEarlier()
          if (signal.aborted || result !== 'applied') {
            return
          }
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
  const start = useCallback(
    (target: NativeChatHistoryJumpTarget) => {
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

  useEffect(() => abort, [abort, sessionKey, isVisible])

  return { pending, start, abort }
}
