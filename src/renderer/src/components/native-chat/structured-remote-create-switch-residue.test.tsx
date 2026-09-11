// @vitest-environment happy-dom
//
// Revoking admission must never strand a session that already exists.
//
// `structuredChatRemoteCreate` is a client policy about STARTING work on somebody else's machine.
// A user who turns it back off — or who never turned it on, and is looking at a chat a peer
// started — still has to be able to stop that work and let go of it. The host side already splits
// its gate this way (cleanup asks only for the negotiated capability, never for admission); these
// are the client half of the same rule.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supportsCapability: vi.fn(async () => true),
  enqueueSettingsWrite: vi.fn()
}))

// A real subscription, not a snapshot read: the whole point is that flipping the switch reaches a
// pane that is already open.
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = { settings: {} as Record<string, unknown> }
  return {
    state,
    set(settings: Record<string, unknown>) {
      state.settings = settings
      for (const listener of listeners) {
        listener()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof store.state) => T): T =>
      useSyncExternalStore(
        store.subscribe,
        () => selector(store.state),
        () => selector(store.state)
      ),
    { getState: () => store.state, subscribe: store.subscribe }
  )
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueueSettingsWrite
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 4,
      commands: null,
      items: [],
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))
vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'op-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { useStructuredAgentSession } from './use-structured-agent-session'

const SESSION_ID = 'session-paired'
const TARGET = { kind: 'environment', environmentId: 'env-1' } as const

function methodCalls(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((call) => call[1] === method)
}

function openPane() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: SESSION_ID,
      agent: 'codex',
      target: TARGET,
      isVisible: true
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supportsCapability.mockResolvedValue(true)
  mocks.call.mockImplementation(async (_target: unknown, method: string) =>
    method === 'agentSession.options'
      ? { current: {}, models: [], conversationCommands: [] }
      : { ok: true, value: {} }
  )
  store.set({ structuredChatRemoteCreate: true })
})

// Explicit: a pane left mounted from an earlier case reacts to the store flips below and answers
// this file's call counts for it.
afterEach(() => {
  cleanup()
})

describe('the remote-create switch on a session that already exists', () => {
  it('takes the hold while it is on', async () => {
    openPane()

    await waitFor(() => expect(methodCalls('agentSession.hold')).toHaveLength(1))
  })

  it('lets go of the hold when the user turns it off, rather than keeping it', async () => {
    const { result } = openPane()
    await waitFor(() => expect(methodCalls('agentSession.hold')).toHaveLength(1))

    await act(async () => {
      store.set({ structuredChatRemoteCreate: false })
    })

    await waitFor(() => expect(methodCalls('agentSession.release')).toHaveLength(1))
    expect(result.current.remoteReadOnly).toBe(true)
    // The release addresses the session it held, on the host that holds it.
    expect(methodCalls('agentSession.release')[0]?.[0]).toEqual(TARGET)
    expect(methodCalls('agentSession.release')[0]?.[2]).toMatchObject({ sessionId: SESSION_ID })
  })

  it('still stops a turn the peer is running once the switch is off', async () => {
    store.set({ structuredChatRemoteCreate: false })
    const { result } = openPane()
    await waitFor(() => expect(result.current.remoteReadOnly).toBe(true))

    await act(async () => {
      await result.current.cancel('turn-1')
    })

    const cancels = methodCalls('agentSession.cancel')
    expect(cancels, 'a revoked switch left a running turn with no way to stop it').toHaveLength(1)
    expect(cancels[0]?.[0]).toEqual(TARGET)
    // Anti-vacuous: the same pane refuses the calls that START work.
    await act(async () => {
      await result.current.respond(
        {
          itemId: 'item-1',
          revision: 1,
          body: { kind: 'approval' }
        } as Parameters<typeof result.current.respond>[0],
        'allow'
      )
    })
    expect(methodCalls('agentSession.respondToApproval')).toHaveLength(0)
    expect(methodCalls('agentSession.hold')).toHaveLength(0)
  })

  it('closes a session the switch no longer admits creating', async () => {
    store.set({ structuredChatRemoteCreate: false })

    await expect(closeStructuredAgentSession(TARGET, SESSION_ID)).resolves.toBe('closed')

    expect(methodCalls('agentSession.close')).toHaveLength(1)
    // Close asks the host for the base structured capability and nothing else — not admission,
    // and not this client's switch.
    expect(mocks.supportsCapability).toHaveBeenCalledWith('env-1', 'agent-session.structured.v1')
  })
})
