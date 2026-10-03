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
  withdrawUnsent: vi.fn(),
  operations: 0
}))
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []
let outbox: StructuredAgentSessionOutboxEntry[] = []
let fence = 3

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false),
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: { fence, items, submissions, status: 'ready', error: null, hasOlder: false },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => `operation-${++mocks.operations}`,
  useStructuredAgentSessionOutbox: () => ({
    outbox,
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
import { projectStructuredAgentSessionStatusSummary } from '../../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
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
  fence = 3
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

  function cancelOperationIds(): string[] {
    return mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.cancel')
      .map(([, , params]) => params.envelope.clientOperationId)
  }

  it('does not let a Stop whose answer never came back replay into every later one', async () => {
    submissions = [submission({ handoverRecorded: true, handedOverAt: 2 })]
    const answers: (() => unknown)[] = [
      () => {
        throw new Error('the connection dropped before the host answered')
      },
      () => ({
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'Outcome unknown.' }
      })
    ]
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.cancel'
        ? (answers.shift()?.() ?? { ok: true, value: { cancelled: true } })
        : null
    )
    const { result } = render()

    for (let press = 0; press < 3; press += 1) {
      await act(async () => {
        await result.current.stop()
      })
    }

    // One key serves every Stop in this chat, so a kept id would replay into a later Stop, which the
    // host answers as already handled and stops nothing for up to a day.
    const ids = cancelOperationIds()
    expect(new Set(ids).size).toBe(3)
  })

  it('sends a Stop of its own for a second press while the first is still on its way', async () => {
    submissions = [submission({ handoverRecorded: true, handedOverAt: 2 })]
    const pending: ((value: unknown) => void)[] = []
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.cancel'
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve(null)
    )
    const { result } = render()

    await act(async () => {
      const presses = [result.current.stop(), result.current.stop()]
      for (const resolve of pending) {
        resolve({ ok: true, value: { cancelled: true } })
      }
      await Promise.all(presses)
    })

    // The host runs them in order; the second acts on whatever is still running, if anything.
    const ids = cancelOperationIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('sends a new Stop after one the host answered once the chat had moved on', async () => {
    items = [RUNNING_TURN]
    const pending: ((value: unknown) => void)[] = []
    mocks.call.mockImplementation((_target, method) =>
      method !== 'agentSession.cancel'
        ? Promise.resolve(null)
        : pending.length === 0
          ? new Promise((resolve) => pending.push(resolve))
          : Promise.resolve({ ok: true, value: { cancelled: true } })
    )
    const { result, rerender } = render()

    let first: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.stop()
    })
    fence = 4
    rerender()
    await act(async () => {
      pending[0]?.({ ok: true, value: { cancelled: true } })
      await first
    })
    await act(async () => {
      await result.current.stop()
    })

    // Reusing the first id would replay it: the host answers not-cancelled and stops nothing.
    const fences: number[] = mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.cancel')
      .map(([, , params]) => params.envelope.expectedRuntimeFence)
    expect(fences).toEqual([3, 4])
    const ids = cancelOperationIds()
    expect(ids[1]).not.toBe(ids[0])
  })

  it('stops a message sent after a Stop whose answer is still on its way', async () => {
    items = [RUNNING_TURN]
    const ran = new Set<string>()
    const pending: (() => void)[] = []
    mocks.call.mockImplementation((_target, method, params) => {
      if (method !== 'agentSession.cancel') {
        return Promise.resolve(null)
      }
      // As the host's ledger does: an id it already ran replays as handled and stops nothing.
      const operationId: string = params.envelope.clientOperationId
      const value = { cancelled: !ran.has(operationId) }
      ran.add(operationId)
      return new Promise((resolve) => pending.push(() => resolve({ ok: true, value })))
    })
    const { result, rerender } = render()

    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.stop()
    })
    // The next message goes out, and reaches the host ahead of the second Stop.
    outbox = [entry('dispatching')]
    rerender()
    act(() => {
      second = result.current.stop()
    })
    await act(async () => {
      for (const answer of pending) {
        answer()
      }
      await Promise.all([first, second])
    })

    expect(await second).toEqual({ cancelled: true })
  })

  it('does not let a lost stop of every background task swallow the next one', async () => {
    const answers: (() => unknown)[] = [
      () => {
        throw new Error('the connection dropped before the host answered')
      }
    ]
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.cancel'
        ? (answers.shift()?.() ?? { ok: true, value: { cancelled: true } })
        : null
    )
    const { result } = render()

    for (let press = 0; press < 2; press += 1) {
      await act(async () => {
        await result.current.stopBackgroundTask()
      })
    }

    const ids = cancelOperationIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('stops one background task on a second press after the first lost its answer', async () => {
    const ran = new Set<string>()
    let lostAnswers = 1
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.cancel') {
        return null
      }
      // As the host's ledger does: an id it already ran replays as handled and stops nothing.
      const operationId: string = params.envelope.clientOperationId
      const value = { cancelled: !ran.has(operationId) }
      ran.add(operationId)
      if (lostAnswers > 0) {
        lostAnswers -= 1
        throw new Error('the connection dropped before the host answered')
      }
      return { ok: true, value }
    })
    const { result } = render()

    let second: unknown
    await act(async () => {
      await result.current.stopBackgroundTask('task-1')
      second = await result.current.stopBackgroundTask('task-1')
    })

    const ids = cancelOperationIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
    expect(second).toEqual({ cancelled: true })
  })

  it('sends a new cancel of a named turn after the host could not settle the last one', async () => {
    const answers: (() => unknown)[] = [
      () => ({
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'Outcome unknown.' }
      })
    ]
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.cancel'
        ? (answers.shift()?.() ?? { ok: true, value: { cancelled: true } })
        : null
    )
    const { result } = render()

    for (let press = 0; press < 2; press += 1) {
      await act(async () => {
        await result.current.cancel('provider-turn')
      })
    }

    // Cancel recovers nothing from an unknown row, so the same id would earn the same refusal.
    const ids = cancelOperationIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('is hidden at rest, and with only a message that will not run', () => {
    expect(render().result.current.canStop).toBe(false)
    outbox = [entry('rejected')]
    submissions = [submission({ dispatchState: 'accepted', resolvedAt: 2 })]
    expect(render().result.current.canStop).toBe(false)
  })

  it('is hidden with only a message that waits on its Retry', () => {
    // A send that failed waits, with its saved failure, until the user retries it.
    outbox = [{ ...entry('queued'), lastFailure: { kind: 'failed' } }]
    expect(render().result.current.canStop).toBe(false)

    // A send the host restarted under is parked for the user, and the chat reads idle.
    outbox = [{ ...entry('unconfirmed'), retryAfterUnknownSubmittedAt: -1 }]
    submissions = [
      submission({
        dispatchState: 'unknown',
        recovered: true,
        reason: 'host_restarted_before_acknowledgement'
      })
    ]
    const { result } = render()
    expect(result.current.isWorking).toBe(false)
    expect(result.current.canStop).toBe(false)
  })
})

const EARLIER_TURN: AgentJournalRenderItem[] = [
  {
    itemId: 'user-0',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'earlier' }] }
  },
  {
    itemId: 'turn-0',
    revision: 2,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'turn-0', state: 'completed', outcome: 'success' }
  }
]

/** The main agent's state as the sidebar row reads it: the host's projection of this journal,
 *  through the same fold the row applies, or null when the session lists no agent at all. */
function sidebarMainAgentState(): string | null {
  const summary = projectStructuredAgentSessionStatusSummary(items, submissions, 3)
  return summary.status
    ? structuredAgentSessionAgentStatus({ ...summary, status: summary.status }).mainAgent.state
    : null
}

// Claude retrying a rate-limited request (HTTP 429) writes only `api_retry` frames: it echoes the
// message and opens a turn only once a request gets through or is interrupted, so the journal holds
// a handed-over send, a row per retry, and no turn for as long as the retries last.
const RATE_LIMIT_RETRY: AgentJournalRenderItem = {
  itemId: 'provider-frame:claude:acquisition:1',
  revision: 3,
  sequence: 3,
  observedAt: 3,
  body: { kind: 'status', text: 'rate_limit', tone: 'error' }
}

const SIDEBAR_STATES = {
  'a first message Claude is retrying after HTTP 429': () => {
    items = [RATE_LIMIT_RETRY]
    submissions = [submission({ handoverRecorded: true, handedOverAt: 2 })]
  },
  'a follow-up Claude is retrying after HTTP 429': () => {
    items = [...EARLIER_TURN, RATE_LIMIT_RETRY]
    submissions = [
      submission({ clientMessageId: 'client-0', dispatchState: 'accepted', resolvedAt: 2 }),
      submission({ handoverRecorded: true, handedOverAt: 3 })
    ]
  },
  'a send whose write was ambiguous, still on the live child': () => {
    items = EARLIER_TURN
    submissions = [submission({ dispatchState: 'unknown', reason: 'write_outcome_unknown' })]
  },
  'a send an earlier child never answered': () => {
    items = EARLIER_TURN
    submissions = [submission({ fence: 2, handoverRecorded: true, handedOverAt: 2 })]
  },
  'a settled turn': () => {
    items = EARLIER_TURN
    submissions = [submission({ dispatchState: 'accepted', resolvedAt: 2 })]
  }
}

describe('Stop against a host that stops the conversation, beside the sidebar', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
    ])
  })

  it.each(Object.entries(SIDEBAR_STATES))(
    'shows exactly when the sidebar reads working, for %s',
    (_state, arrange) => {
      arrange()
      const { result } = render()

      expect(result.current.canStop).toBe(sidebarMainAgentState() === 'working')
      expect(result.current.isWorking).toBe(result.current.canStop)
    }
  )

  it('is there for a rate-limited request the sidebar reads as working', () => {
    SIDEBAR_STATES['a follow-up Claude is retrying after HTTP 429']()
    const { result } = render()

    expect(sidebarMainAgentState()).toBe('working')
    expect(result.current.turnId).toBeNull()
    expect(result.current.canStop).toBe(true)
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
