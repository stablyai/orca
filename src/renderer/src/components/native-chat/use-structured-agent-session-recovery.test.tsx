// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

const target = { kind: 'environment', environmentId: 'synthetic-remote' } as const
const sessionId = 'recovery-test'
let restoreStorage: (() => void) | undefined
function mount(fence: number | null = 1) {
  return renderHook(
    ({ fence, submissions }: { fence: number | null; submissions: AgentJournalSubmission[] }) =>
      useStructuredAgentSessionOutbox({ sessionId, target, fence, submissions }),
    { initialProps: { fence, submissions: [] as AgentJournalSubmission[] } }
  )
}
async function advance(ms = 16000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function seed() {
  const head = {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'head',
      sessionId,
      text: 'retain this',
      attachments: [{ path: '/synthetic/image.png', previewUri: 'synthetic-preview' }],
      queuedAt: 1
    }),
    state: 'unconfirmed' as const
  }
  expect(writeOutbox(sessionId, [head])).toBe(true)
  return head
}

describe('durable structured session recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1700000100000)
    localStorage.clear()
    mocks.call.mockReset().mockRejectedValue(new Error('connection closed'))
  })
  afterEach(() => {
    restoreStorage?.()
    restoreStorage = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('spends eight probes then parks across 100 advances, remount and fence changes', async () => {
    const original = seed()
    let hook = mount()
    expect(readOutbox(sessionId)[0]?.recovery).toMatchObject({
      attempts: 1,
      nextProbeAt: 1700000101000
    })
    for (let i = 0; i < 8; i++) {
      await advance()
    }
    expect(mocks.call).toHaveBeenCalledTimes(8)
    expect(hook.result.current.recoveryPaused).toBe(true)
    expect(readOutbox(sessionId)[0]).toMatchObject({
      body: original.body,
      previewUris: original.previewUris,
      state: 'unconfirmed',
      recovery: { attempts: 8, nextProbeAt: null, parkedReason: 'budget-exhausted' }
    })
    hook.unmount()
    hook = mount(null)
    hook.rerender({ fence: 2, submissions: [] })
    for (let i = 0; i < 100; i++) {
      await advance()
    }
    expect(mocks.call).toHaveBeenCalledTimes(8)
    expect(hook.result.current.recoveryPaused).toBe(true)
    hook.unmount()
  })

  it('preserves the reserved deadline on remount and safe resume retains the envelope', async () => {
    seed()
    let hook = mount()
    await advance(500)
    hook.unmount()
    hook = mount(2)
    expect(readOutbox(sessionId)[0]?.recovery?.attempts).toBe(1)
    await advance(500)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 8; i++) {
      await advance()
    }
    expect(hook.result.current.recoveryPaused).toBe(true)
    const before = mocks.call.mock.calls[0]![2]
    act(() => hook.result.current.resumeChecking('head'))
    await advance(1000)
    expect(mocks.call).toHaveBeenCalledTimes(9)
    expect(mocks.call.mock.calls[8]![2]).toEqual(before)
    expect(before).not.toHaveProperty('retryUnknown')
    hook.unmount()
  })

  it('settles a parked head from late host evidence and sends its tail exactly once', async () => {
    seed()
    const hook = mount()
    for (let i = 0; i < 8; i++) {
      await advance()
    }
    const accepted: AgentJournalSubmission = {
      clientMessageId: 'head',
      fence: 1,
      payloadFingerprint: 'synthetic',
      dispatchState: 'accepted',
      providerItemId: 'item',
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    mocks.call.mockImplementation(async (_target, _method, params) => ({
      ok: true,
      value: { submission: { ...accepted, clientMessageId: params.envelope.clientOperationId } }
    }))
    act(() => {
      hook.result.current.send('tail')
    })
    await act(async () => {
      hook.rerender({ fence: 2, submissions: [accepted] })
    })
    expect(hook.result.current.outbox).toHaveLength(0)
    expect(mocks.call).toHaveBeenCalledTimes(9)
    hook.unmount()
  })

  it('stops before timer/RPC adoption on storage failure and permits an explicit recovery', async () => {
    const original = seed()
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    restoreStorage = () => storage.mockRestore()
    const hook = mount()
    for (let i = 0; i < 10; i++) {
      await advance()
    }
    expect(mocks.call).not.toHaveBeenCalled()
    expect(hook.result.current.outbox[0]).toEqual(original)
    expect(hook.result.current.error).toBe('Message could not be saved to the outbox')
    expect(hook.result.current.recoveryPaused).toBe(true)
    storage.mockRestore()
    act(() => hook.result.current.resumeChecking('head'))
    await advance(1000)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('does not renew an in-flight last probe on fence changes or accept its stale callback', async () => {
    const entry = seed()
    writeOutbox(sessionId, [
      { ...entry, recovery: { attempts: 7, nextProbeAt: null, parkedReason: null } }
    ])
    let finish!: (value: unknown) => void
    mocks.call.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const hook = mount()
    await advance()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    hook.rerender({ fence: 2, submissions: [] })
    await advance()
    expect(hook.result.current.recoveryPaused).toBe(true)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    })
    expect(hook.result.current.outbox).toHaveLength(1)
    hook.unmount()
  })

  it('requires a durable queued transition before a reserved timer can dispatch', async () => {
    seed()
    const hook = mount()
    const reserved = readOutbox(sessionId)
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    restoreStorage = () => storage.mockRestore()
    await advance()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(hook.result.current.outbox).toEqual(reserved)
    expect(hook.result.current.recoveryPaused).toBe(true)
    storage.mockRestore()
    hook.unmount()
  })

  it('does not probe null fences, host-observed uncertainty or explicit force retries', async () => {
    seed()
    const hook = mount(null)
    await advance()
    expect(readOutbox(sessionId)[0]?.recovery).toBeUndefined()
    const unknown: AgentJournalSubmission = {
      clientMessageId: 'head',
      fence: 1,
      payloadFingerprint: 'synthetic',
      dispatchState: 'unknown',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    hook.rerender({ fence: 1, submissions: [unknown] })
    await advance()
    expect(mocks.call).not.toHaveBeenCalled()
    await act(async () => {
      hook.result.current.retry('head')
    })
    expect(mocks.call.mock.calls[0]![2]).toHaveProperty('retryUnknown', true)
    hook.rerender({ fence: 2, submissions: [] })
    for (let i = 0; i < 10; i++) {
      await advance()
    }
    expect(mocks.call).toHaveBeenCalledTimes(1)
    hook.unmount()
  })
})
