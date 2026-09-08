// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
const sessionId = 'independent-synthetic-lifetime'
const target = { kind: 'environment', environmentId: 'independent-synthetic-host' } as const
const submissions = []
function mount() {
  return renderHook(() =>
    useStructuredAgentSessionOutbox({ sessionId, target, fence: 1, submissions })
  )
}
async function advance(ms = 16000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1700000100000)
  localStorage.clear()
  mocks.call.mockReset().mockRejectedValue(new Error('connection closed'))
  writeOutbox(sessionId, [
    {
      ...createStructuredAgentSessionOutboxEntry({
        sessionId,
        clientMessageId: 'op',
        text: 'preserve',
        attachments: [],
        queuedAt: 1
      }),
      state: 'unconfirmed'
    }
  ])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('late completion from an unmounted owner cannot rewind a parked durable budget', async () => {
  let rejectOld!: (error: Error) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const old = mount()
  await advance(1000)
  expect(mocks.call).toHaveBeenCalledTimes(1)
  old.unmount()
  const current = mount()
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(8)
  expect(current.result.current.recoveryPaused).toBe(true)
  expect(readOutbox(sessionId)[0].recovery?.attempts).toBe(8)
  await act(async () => {
    rejectOld(new Error('connection closed'))
  })
  const storedAfterOldCallback = readOutbox(sessionId)[0].recovery
  current.unmount()
  const restarted = mount()
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  console.log(
    'late-owner observation',
    JSON.stringify({
      storedAfterOldCallback,
      totalCalls: mocks.call.mock.calls.length,
      parked: restarted.result.current.recoveryPaused
    })
  )
  expect(mocks.call).toHaveBeenCalledTimes(8)
  expect(storedAfterOldCallback?.attempts).toBe(8)
})
it('two current owners share one eight-probe operation budget', async () => {
  const first = mount()
  const second = mount()
  for (let i = 0; i < 12; i++) {
    await advance()
  }
  console.log(
    'two-owner observation',
    JSON.stringify({
      calls: mocks.call.mock.calls.length,
      firstPaused: first.result.current.recoveryPaused,
      secondPaused: second.result.current.recoveryPaused,
      stored: readOutbox(sessionId)[0].recovery
    })
  )
  expect(mocks.call).toHaveBeenCalledTimes(8)
})
it('control: one owner parks after eight and remains parked on remount', async () => {
  const first = mount()
  for (let i = 0; i < 12; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(8)
  first.unmount()
  mount()
  for (let i = 0; i < 12; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(8)
})
it('late owner rewinds progress even when its RPC settles after only three seconds', async () => {
  let rejectOld!: (error: Error) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const old = mount()
  await advance(1000)
  old.unmount()
  const current = mount()
  await advance(2000)
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(readOutbox(sessionId)[0].recovery?.attempts).toBe(3)
  await act(async () => {
    rejectOld(new Error('connection closed'))
  })
  const rewound = readOutbox(sessionId)[0].recovery?.attempts
  current.unmount()
  mount()
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  console.log(
    'short-latency observation',
    JSON.stringify({ rewound, calls: mocks.call.mock.calls.length })
  )
  expect(mocks.call).toHaveBeenCalledTimes(8)
})

function accepted(clientMessageId = 'op') {
  return { ok: true, value: { submission: { clientMessageId, dispatchState: 'accepted' } } }
}

it('late host acceptance settles the current operation and advances FIFO while another probe is pending', async () => {
  let acceptOld!: (value: unknown) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acceptOld = resolve
      })
  )
  const old = mount()
  await advance(1000)
  old.unmount()
  mocks.call.mockImplementationOnce(() => new Promise(() => {}))
  const current = mount()
  await advance(2000)
  expect(mocks.call).toHaveBeenCalledTimes(2)
  act(() => {
    current.result.current.send('tail')
  })
  mocks.call.mockImplementationOnce(async (_target, _method, params) =>
    accepted(params.envelope.clientOperationId)
  )
  await act(async () => {
    acceptOld(accepted())
  })
  expect(mocks.call).toHaveBeenCalledTimes(3)
  expect(current.result.current.outbox).toEqual([])
  expect(readOutbox(sessionId)).toEqual([])
})

it('an obsolete acceptance cannot retire an explicit force Retry incarnation', async () => {
  let acceptOld!: (value: unknown) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acceptOld = resolve
      })
  )
  const old = mount()
  await advance(1000)
  old.unmount()
  const current = mount()
  await act(async () => {
    current.result.current.retry('op')
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(mocks.call.mock.calls[1][2].retryUnknown).toBe(true)
  const before = readOutbox(sessionId)
  await act(async () => {
    acceptOld(accepted())
  })
  expect(readOutbox(sessionId)).toEqual(before)
  expect(current.result.current.outbox).toHaveLength(1)
})

it('concurrent Resume controls renew one budget and a predecessor failure cannot overwrite it', async () => {
  let rejectOld!: (error: Error) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const old = mount()
  await advance(1000)
  old.unmount()
  const first = mount()
  const second = mount()
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(8)
  act(() => {
    first.result.current.resumeChecking('op')
    second.result.current.resumeChecking('op')
  })
  await advance(1000)
  const before = readOutbox(sessionId)
  await act(async () => {
    rejectOld(new Error('connection closed'))
  })
  expect(readOutbox(sessionId)).toEqual(before)
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(16)
})

it('a refusal blocks automatic dispatch for every current owner until explicit Retry', async () => {
  mocks.call.mockResolvedValue({
    ok: false,
    refusal: { code: 'agent_session_checkpoint_stale', message: 'refused' }
  })
  const first = mount()
  mount()
  for (let i = 0; i < 8; i++) {
    await advance()
  }
  expect(mocks.call).toHaveBeenCalledTimes(1)
  await act(async () => {
    first.result.current.retry('op')
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
})

it('failed persistence cannot grant either owner a dispatch claim', async () => {
  const first = mount()
  mount()
  const saved = readOutbox(sessionId)
  const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  await advance()
  expect(mocks.call).not.toHaveBeenCalled()
  expect(readOutbox(sessionId)).toEqual(saved)
  expect(first.result.current.recoveryPaused).toBe(true)
  storage.mockRestore()
})

it('a predecessor refusal cannot rotate or block the operation owned by a pending successor', async () => {
  let refuseOld!: (value: unknown) => void
  mocks.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        refuseOld = resolve
      })
  )
  const old = mount()
  await advance(1000)
  old.unmount()
  mocks.call.mockImplementationOnce(() => new Promise(() => {}))
  const current = mount()
  await advance(2000)
  expect(mocks.call).toHaveBeenCalledTimes(2)
  await act(async () => {
    refuseOld({
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        message: 'old conflict'
      }
    })
  })
  expect(current.result.current.outbox[0]).toMatchObject({
    clientMessageId: 'op',
    state: 'dispatching',
    recovery: { attempts: 2 }
  })
  expect(current.result.current.blockedClientMessageId).toBeNull()
})

it('mounting beside a pending owner does not recover its live dispatch as an orphan', async () => {
  mocks.call.mockImplementationOnce(() => new Promise(() => {}))
  mount()
  await advance(1000)
  const second = mount()
  await advance()
  expect(mocks.call).toHaveBeenCalledTimes(1)
  expect(second.result.current.outbox[0].state).toBe('dispatching')
})
