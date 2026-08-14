import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentSessionHandoffStatus,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
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
      const [result, handoff] = await Promise.all([
        callStructuredAgentSession<AgentSessionHistoryResult>(target, 'agentSession.history', {
          sessionId,
          direction: 'tail',
          limit: 40
        }),
        callStructuredAgentSession<AgentSessionHandoffStatus>(
          target,
          'agentSession.handoffStatus',
          { sessionId }
        ).catch(() => null)
      ])
      if (stopped) {
        return
      }
      if (result.ok) {
        dispatch({ type: 'tail-page', page: result.page })
        resumeCursorRef.current = result.page.liveCursor ?? null
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
      if (handoff) {
        dispatch({ type: 'handoff', handoff })
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
        { sessionId, direction: 'before', cursor, limit: 40 }
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
