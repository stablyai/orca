import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentSessionHandoffStatus,
  AgentSessionHistoryResult
} from '../../../../shared/agent-session-wire'
import {
  projectStructuredAgentSessionStatus,
  structuredAgentSessionPaneKey
} from '../../../../shared/structured-agent-session-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  shouldAdvanceStructuredResumeCursor,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import type { Tab } from '../../../../shared/tab-types'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  callStructuredAgentSession,
  subscribeStructuredAgentSession
} from '@/runtime/structured-agent-session-client'
import {
  clearStructuredHandoff,
  publishStructuredHandoff
} from '@/runtime/structured-agent-session-handoff-store'

type StructuredTab = Tab & { contentType: 'agent-session' }

function latestPrompt(state: StructuredAgentSessionState): string {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const body = state.items[index]?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    }
  }
  return ''
}

function projectStatus(tab: StructuredTab, state: StructuredAgentSessionState): void {
  const projection = projectStructuredAgentSessionStatus(state.items)
  const store = useAppStore.getState()
  store.setAgentStatus(
    structuredAgentSessionPaneKey(tab.id, tab.entityId),
    {
      state: projection === 'working' ? 'working' : projection === 'attention' ? 'blocked' : 'done',
      prompt: latestPrompt(state),
      agentType: tab.agentSessionAgent ?? 'codex',
      sessionBoundary: projection === 'idle'
    },
    tab.label,
    undefined,
    { tabId: tab.id, worktreeId: tab.worktreeId },
    { providerSession: { key: 'session_id', id: tab.entityId } }
  )
}

function startStatusProjection(tab: StructuredTab, target: RuntimeClientTarget): () => void {
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  let stopped = false
  let connected = false
  let opening = false
  let unsubscribe = (): void => {}
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const apply = (action: Parameters<typeof reduceStructuredAgentSession>[1]): void => {
    state = reduceStructuredAgentSession(state, action)
    projectStatus(tab, state)
  }
  const scheduleReconnect = (): void => {
    if (stopped || connected || reconnectTimer) {
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void open()
    }, 750)
  }
  const open = async (): Promise<void> => {
    if (stopped || connected) {
      return
    }
    if (opening) {
      scheduleReconnect()
      return
    }
    opening = true
    unsubscribe()
    unsubscribe = (): void => {}
    try {
      let closedDuringOpen = false
      const handle = await subscribeStructuredAgentSession(
        target,
        { sessionId: tab.entityId, ...(state.cursor ? { cursor: state.cursor } : {}) },
        (event) => {
          if ('handoff' in event && event.handoff) {
            publishStructuredHandoff({
              sessionId: tab.entityId,
              fence: event.fence ?? state.fence ?? 0,
              status: event.handoff
            })
          }
          if (
            event.type === 'batch' &&
            !shouldAdvanceStructuredResumeCursor(state.cursor, event.batch.cursor)
          ) {
            return
          }
          if (event.type === 'end') {
            closedDuringOpen = true
            connected = false
            scheduleReconnect()
          }
          apply({ type: 'event', event })
        },
        () => {
          closedDuringOpen = true
          connected = false
          scheduleReconnect()
        },
        () => {
          closedDuringOpen = true
          connected = false
          scheduleReconnect()
        }
      )
      if (stopped || closedDuringOpen) {
        handle.unsubscribe()
        if (!stopped) {
          scheduleReconnect()
        }
      } else {
        connected = true
        unsubscribe = handle.unsubscribe
      }
    } catch {
      connected = false
      scheduleReconnect()
    } finally {
      opening = false
    }
  }
  void Promise.all([
    callStructuredAgentSession<AgentSessionHistoryResult>(target, 'agentSession.history', {
      sessionId: tab.entityId,
      direction: 'tail',
      limit: 40
    }),
    callStructuredAgentSession<AgentSessionHandoffStatus>(target, 'agentSession.handoffStatus', {
      sessionId: tab.entityId
    }).catch(() => null)
  ])
    .then(async ([result, handoff]) => {
      if (stopped) {
        return
      }
      if (result.ok) {
        apply({ type: 'tail-page', page: result.page })
      } else {
        apply({
          type: 'event',
          event: {
            type: 'reset',
            sessionId: tab.entityId,
            reset: result.reset,
            snapshot: result.snapshot,
            fence: result.fence ?? 0
          }
        })
      }
      if (handoff) {
        apply({ type: 'handoff', handoff })
        publishStructuredHandoff({
          sessionId: tab.entityId,
          fence: result.ok ? (result.page.fence ?? 0) : (result.fence ?? 0),
          status: handoff
        })
      }
      await open()
    })
    .catch(scheduleReconnect)
  return () => {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    unsubscribe()
    clearStructuredHandoff(tab.entityId)
    useAppStore.getState().removeAgentStatus(structuredAgentSessionPaneKey(tab.id, tab.entityId))
  }
}

function StructuredAgentSessionStatusProjection({ tab }: { tab: StructuredTab }): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  useEffect(() => startStatusProjection(tab, target), [tab, target])
  return null
}

export function StructuredAgentSessionStatusBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) =>
      Object.values(state.unifiedTabsByWorktree)
        .flat()
        .filter((tab): tab is StructuredTab => tab.contentType === 'agent-session')
    )
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionStatusProjection key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
