// @vitest-environment happy-dom

// Stop is there from the moment a message is sent until the work settles — against a host that takes
// a Stop naming no turn. Against any other host, one that accepts sends first included, it stays
// exactly what it was: a running turn only, named.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  withdrawUnsent: vi.fn()
}))
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []
let outbox: StructuredAgentSessionOutboxEntry[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: { fence: 3, items, submissions, status: 'ready', error: null, hasOlder: false },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox,
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn(),
    withdrawUnsent: mocks.withdrawUnsent
  })
}))

import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSession } from './use-structured-agent-session'

function entry(
  state: StructuredAgentSessionOutboxEntry['state']
): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId: 'client-1',
    sessionId: 'session-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    previewUris: [],
    state,
    queuedAt: 1,
    lastAttemptAt: null,
    retryAfterUnknownSubmittedAt: null
  }
}

function submission(overrides: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'client-1',
    fence: 3,
    payloadFingerprint: 'fingerprint-1',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...overrides
  }
}

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

// Every way work can be in flight after a send, in the order a message passes through them.
const IN_FLIGHT = {
  'the send is on its way to the host': () => {
    outbox = [entry('dispatching')]
  },
  'the host has queued it': () => {
    submissions = [submission({ handoverRecorded: true })]
  },
  'it was handed over and is unanswered': () => {
    submissions = [submission({ handoverRecorded: true, handedOverAt: 2 })]
  },
  'a turn is running': () => {
    items = [RUNNING_TURN]
  }
}

function render() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'claude',
      target: { kind: 'local' },
      isVisible: true
    })
  )
}

function cancels(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.cancel')
    .map(([, , params]) => params)
}

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.cancel' ? { ok: true, value: { cancelled: true } } : null
  )
  items = []
  submissions = []
  outbox = []
})

describe('Stop against a host that stops the conversation', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
    ])
  })

  it.each(Object.entries(IN_FLIGHT))(
    'shows while %s, and stops the conversation',
    async (_state, arrange) => {
      arrange()
      const { result } = render()

      expect(result.current.canStop).toBe(true)
      await act(async () => {
        await result.current.stop()
      })

      expect(mocks.withdrawUnsent).toHaveBeenCalledOnce()
      // Withdrawn first, so the drain has nothing left to send after the Stop.
      const cancelCall = mocks.call.mock.calls.findIndex(
        ([, method]) => method === 'agentSession.cancel'
      )
      expect(mocks.withdrawUnsent.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.call.mock.invocationCallOrder[cancelCall] ?? 0
      )
      expect(cancels()).toEqual([expect.not.objectContaining({ turnId: expect.anything() })])
    }
  )

  it('is hidden at rest, and with only a message that will not run', () => {
    expect(render().result.current.canStop).toBe(false)
    outbox = [entry('rejected')]
    submissions = [submission({ dispatchState: 'accepted', resolvedAt: 2 })]
    expect(render().result.current.canStop).toBe(false)
  })
})

// A host that accepts sends first but predates the no-turn cancel refuses that cancel as invalid,
// so it is treated exactly as an older host; so is one whose capabilities are not known yet.
describe.each([
  ['one that only accepts sends first', [AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY]],
  ['an older one', []],
  ['one not heard from yet', null]
])('Stop against a host that is %s', (_host, capabilities) => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests(capabilities)
  })

  it.each(Object.entries(IN_FLIGHT).filter(([state]) => state !== 'a turn is running'))(
    'stays hidden while %s, and sends no cancel naming no turn',
    async (_state, arrange) => {
      arrange()
      const { result } = render()

      expect(result.current.canStop).toBe(false)
      await act(async () => {
        await result.current.stop()
      })
      expect(cancels()).toEqual([])
      expect(mocks.withdrawUnsent).not.toHaveBeenCalled()
    }
  )

  it('stops a running turn by name, as it always did', async () => {
    items = [RUNNING_TURN]
    const { result } = render()

    expect(result.current.canStop).toBe(true)
    await act(async () => {
      await result.current.stop()
    })
    expect(cancels()).toEqual([expect.objectContaining({ turnId: 'provider-turn' })])
    expect(mocks.withdrawUnsent).not.toHaveBeenCalled()
  })
})
