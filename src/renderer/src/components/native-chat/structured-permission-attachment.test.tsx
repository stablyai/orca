// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

const mocks = vi.hoisted(() => ({ call: vi.fn(), failures: new Array<(error: Error) => void>() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  getStructuredLaunchStateBySessionId: () => undefined,
  notifyStructuredLaunchListeners: () => {},
  subscribeStructuredAgentLaunchStatus: () => () => {}
}))
const target = { kind: 'environment', environmentId: 'permission-host' } as const
const seedOptions = { permissionMode: 'ask' }
const heldOptions = {}
beforeEach(() => {
  mocks.call.mockReset()
  mocks.failures.length = 0
})

it.each(['claude', 'codex'] satisfies AgentType[])(
  'keeps a published %s Full access pick through first snapshot and failed refresh',
  async (agent) => {
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.options') {
        return new Promise((_resolve, reject) => mocks.failures.push(reject))
      }
      if (method === 'agentSession.history') {
        return { ok: true, page: { fence: 7 } }
      }
      if (method === 'agentSession.setOption') {
        return {
          ok: true,
          value: {
            key: 'permissionMode',
            value: 'bypass',
            options: { permissionMode: 'bypass' },
            permissionFact: { mode: 'bypass', fence: 7, revision: 2 }
          }
        }
      }
      return { origin: 'unknown' }
    })
    const { result, rerender, unmount } = renderHook(
      (state: StructuredAgentSessionState) => {
        const stateRef = useRef(state)
        useLayoutEffect(() => {
          stateRef.current = state
        }, [state])
        const { mutate } = useStructuredAgentSessionMutate({ sessionId: 'chat', target, stateRef })
        return useStructuredAgentSessionOptions({
          agent,
          sessionId: 'chat',
          target,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          fence: state.fence,
          turnId: null,
          permissionMode: state.permissionMode,
          permissionRevision: state.permissionRevision,
          permissionPublication: state.permissionPublication,
          unloadedTurnRevisions: undefined,
          mutate,
          launch: { kind: 'new', seedOptions, heldOptions }
        })
      },
      { initialProps: EMPTY_STRUCTURED_AGENT_SESSION }
    )
    await act(async () => {
      expect(await result.current.optionSurface.permissionPicker?.setMode('bypass')).toBe(true)
    })
    expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
    expect(mocks.call).toHaveBeenCalledWith(
      target,
      'agentSession.setOption',
      expect.objectContaining({ envelope: expect.objectContaining({ expectedRuntimeFence: 7 }) })
    )
    const attached = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'chat',
        fence: 7,
        permissionMode: 'bypass',
        permissionRevision: 2,
        page: {
          sessionId: 'chat',
          epoch: 'e',
          direction: 'tail',
          items: [],
          submissions: [],
          removedItemIds: [],
          hasOlder: false,
          hasNewer: false,
          window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 0 } }
        }
      }
    })
    rerender(attached)
    expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
    await act(async () =>
      mocks.failures.forEach((reject) => reject(new Error('Options unavailable')))
    )
    expect(result.current.optionSurface.permissionPicker?.current).toBe('bypass')
    unmount()
  }
)
