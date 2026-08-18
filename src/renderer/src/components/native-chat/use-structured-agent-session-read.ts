import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryResult,
  type AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionEventCoalescer } from '../../../../shared/structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  shouldAdvanceStructuredResumeCursor
} from '../../../../shared/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  callStructuredAgentSession,
  subscribeStructuredAgentSession
} from '@/runtime/structured-agent-session-client'
import { NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'

function countsTowardInitialHistory(item: AgentJournalRenderItem): boolean {
  return item.body.kind !== 'status' || !item.body.providerFrame
}

function createReconnectScheduler(args: { shouldStop: () => boolean; reconnect: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(delay = 750): void {
      if (args.shouldStop() || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

export function useStructuredAgentSessionRead(args: {
  sessionId: string
  target: RuntimeClientTarget
}) {
  const { sessionId, target } = args
  const [state, dispatch] = useReducer(reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION)
  const stateRef = useRef(state)
  const resumeCursorRef = useRef(state.cursor)
  const [loadingOlder, setLoadingOlder] = useState(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    resumeCursorRef.current = null
    dispatch({ type: 'loading' })
    let stopped = false
    let connected = false
    let opening = false
    let unsubscribe = (): void => {}
    const coalescer = createStructuredAgentSessionEventCoalescer((event) =>
      dispatch({ type: 'event', event })
    )
    const reconnectScheduler = createReconnectScheduler({
      shouldStop: () => stopped || connected,
      reconnect: () => void open()
    })
    async function open(): Promise<void> {
      if (stopped || connected) {
        return
      }
      if (opening) {
        reconnectScheduler.schedule()
        return
      }
      opening = true
      unsubscribe()
      unsubscribe = (): void => {}
      try {
        const cursor = resumeCursorRef.current
        let closedDuringOpen = false
        const handle = await subscribeStructuredAgentSession(
          target,
          { sessionId, ...(cursor ? { cursor } : {}) },
          (event: AgentSessionSubscribeEvent) => {
            if (event.type === 'snapshot' || event.type === 'reset') {
              resumeCursorRef.current = event.snapshot.cursor
            } else if (
              event.type === 'batch' &&
              shouldAdvanceStructuredResumeCursor(resumeCursorRef.current, event.batch.cursor)
            ) {
              resumeCursorRef.current = event.batch.cursor
            } else if (event.type === 'end') {
              closedDuringOpen = true
              connected = false
              reconnectScheduler.schedule()
            }
            coalescer.push(event)
          },
          (error) => {
            closedDuringOpen = true
            connected = false
            dispatch({ type: 'error', message: String(error) })
            reconnectScheduler.schedule()
          },
          () => {
            closedDuringOpen = true
            connected = false
            reconnectScheduler.schedule()
          }
        )
        if (stopped || closedDuringOpen) {
          handle.unsubscribe()
          if (!stopped) {
            reconnectScheduler.schedule()
          }
        } else {
          connected = true
          unsubscribe = handle.unsubscribe
        }
      } catch (error) {
        connected = false
        dispatch({ type: 'error', message: String(error) })
        reconnectScheduler.schedule()
      } finally {
        opening = false
      }
    }
    async function refreshTail(): Promise<void> {
      const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        { sessionId, direction: 'tail', limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
      )
      if (stopped) {
        return
      }
      if (result.ok) {
        dispatch({ type: 'tail-page', page: result.page })
        resumeCursorRef.current = result.page.liveCursor ?? null
        let page = result.page
        let restored = page.items.filter(countsTowardInitialHistory).length
        while (page.hasOlder && restored < NATIVE_CHAT_INITIAL_LIMIT) {
          const oldest = page.window.oldest
          if (!oldest || stopped) {
            break
          }
          const missing = NATIVE_CHAT_INITIAL_LIMIT - restored
          const older = await callStructuredAgentSession<AgentSessionHistoryResult>(
            target,
            'agentSession.history',
            {
              sessionId,
              direction: 'before',
              cursor: oldest,
              limit: Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, missing)
            }
          )
          if (!older.ok || older.page.window.oldest?.sequence === oldest.sequence) {
            break
          }
          dispatch({ type: 'older-page', requestedEpoch: oldest.epoch, page: older.page })
          restored += older.page.items.filter(countsTowardInitialHistory).length
          page = older.page
        }
      } else {
        dispatch({
          type: 'event',
          event: {
            type: 'reset',
            sessionId,
            reset: result.reset,
            snapshot: result.snapshot,
            fence: result.fence ?? 0
          }
        })
        resumeCursorRef.current = result.snapshot.cursor
      }
    }
    const refreshOnFocus = (): void => {
      if (!document.hasFocus()) {
        return
      }
      void refreshTail()
        .catch((error) => dispatch({ type: 'error', message: String(error) }))
        .finally(() => {
          if (!connected) {
            reconnectScheduler.schedule(0)
          }
        })
    }
    window.addEventListener('focus', refreshOnFocus)
    void refreshTail()
      .then(() => open())
      .catch((error) => {
        dispatch({ type: 'error', message: String(error) })
        reconnectScheduler.schedule()
      })
    return () => {
      stopped = true
      window.removeEventListener('focus', refreshOnFocus)
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    }
  }, [sessionId, target])

  const loadOlder = useCallback(async (): Promise<void> => {
    const cursor = oldestStructuredAgentSessionCursor(stateRef.current)
    if (!cursor || !stateRef.current.hasOlder || loadingOlder) {
      return
    }
    setLoadingOlder(true)
    try {
      const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
        target,
        'agentSession.history',
        { sessionId, direction: 'before', cursor, limit: AGENT_SESSION_HISTORY_MAX_LIMIT }
      )
      if (result.ok) {
        dispatch({ type: 'older-page', requestedEpoch: cursor.epoch, page: result.page })
      }
    } catch (error) {
      dispatch({ type: 'error', message: String(error) })
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder, sessionId, target])

  return { state, loadingOlder, loadOlder }
}
