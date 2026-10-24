import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { sendPromptWithGuardedPasteAndEnter } from './active-agent-note-send-delivery'

const harness = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: harness.rpc }))

beforeEach(() => {
  harness.rpc.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('agent note submission receipts', () => {
  it('sends one raw prompt and observes its receipt across several RPC budgets without sending Enter', async () => {
    vi.useFakeTimers()
    const received = Promise.withResolvers<void>()
    let observations = 0
    harness.rpc.mockImplementation(async (_target, method, params) => {
      switch (method) {
        case 'terminal.agentStatus':
          return { agentStatus: { isRunningAgent: true, status: 'idle' } }
        case 'terminal.submitPrompt':
          return { submission: { requestId: params.requestId, status: 'pending' } }
        case 'terminal.waitPrompt':
          observations += 1
          if (observations < 3) {
            await new Promise((resolve) => setTimeout(resolve, 10_000))
            return { submission: { requestId: params.requestId, status: 'pending' } }
          }
          await received.promise
          return {
            submission: {
              requestId: params.requestId,
              status: 'submitted',
              send: { accepted: true }
            }
          }
        default:
          throw new Error(method)
      }
    })
    let delivered = false
    const delivery = sendPromptWithGuardedPasteAndEnter(
      { kind: 'local' },
      'terminal',
      'feedback\nwith \x1b text',
      { allowLegacyFallback: false }
    ).then((result) => {
      delivered = true
      return result
    })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(delivered).toBe(false)
    const admission = harness.rpc.mock.calls.find((call) => call[1] === 'terminal.submitPrompt')
    expect(admission?.[2].prompt).toBe('feedback\nwith \x1b text')
    received.resolve()
    await expect(delivery).resolves.toEqual({ status: 'sent' })
    expect(
      harness.rpc.mock.calls.filter((call) => call[1] === 'terminal.submitPrompt')
    ).toHaveLength(1)
    expect(harness.rpc.mock.calls.filter((call) => call[1] === 'terminal.send')).toHaveLength(0)
  })

  it.each([
    { reason: 'permission', inputWritten: false, status: 'permission' },
    { reason: 'no-agent', inputWritten: false, status: 'no-agent' },
    { reason: 'not-writable', inputWritten: false, status: 'not-writable' },
    { reason: 'permission', inputWritten: true, status: 'partial-submit-failed' }
  ])(
    'reports $reason after inputWritten=$inputWritten without retrying',
    async ({ reason, inputWritten, status }) => {
      harness.rpc.mockImplementation(async (_target, method, params) =>
        method === 'terminal.agentStatus'
          ? { agentStatus: { isRunningAgent: true, status: 'idle' } }
          : { submission: { requestId: params.requestId, status: 'failed', reason, inputWritten } }
      )
      await expect(
        sendPromptWithGuardedPasteAndEnter({ kind: 'local' }, 'terminal', 'feedback', {
          allowLegacyFallback: false
        })
      ).resolves.toMatchObject({ status })
      expect(harness.rpc.mock.calls.map((call) => call[1])).toEqual([
        'terminal.agentStatus',
        'terminal.submitPrompt'
      ])
    }
  )

  it.each(['terminal.submitPrompt', 'terminal.waitPrompt'])(
    'keeps an ambiguous %s result unconfirmed without a second send',
    async (failedMethod) => {
      harness.rpc.mockImplementation(async (_target, method, params) => {
        if (method === failedMethod) {
          throw new Error('runtime timeout')
        }
        if (method === 'terminal.agentStatus') {
          return { agentStatus: { isRunningAgent: true, status: 'idle' } }
        }
        return { submission: { requestId: params.requestId, status: 'pending' } }
      })
      await expect(
        sendPromptWithGuardedPasteAndEnter({ kind: 'local' }, 'terminal', 'feedback', {
          allowLegacyFallback: false
        })
      ).resolves.toMatchObject({ status: 'unconfirmed' })
      expect(harness.rpc.mock.calls.some((call) => call[1] === 'terminal.send')).toBe(false)
    }
  )

  it('uses the existing guarded paste protocol only after a method-not-found refusal', async () => {
    vi.useFakeTimers()
    harness.rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { isRunningAgent: true, status: 'idle' } }
      }
      if (method === 'terminal.submitPrompt') {
        throw new RuntimeRpcCallError({
          id: 'submit',
          ok: false,
          error: { code: 'method_not_found', message: 'Older host' }
        })
      }
      return { send: { accepted: true } }
    })
    const delivery = sendPromptWithGuardedPasteAndEnter({ kind: 'local' }, 'terminal', 'feedback', {
      allowLegacyFallback: false
    })
    await vi.runAllTimersAsync()
    await expect(delivery).resolves.toEqual({ status: 'sent' })
    expect(
      harness.rpc.mock.calls.filter((call) => call[1] === 'terminal.send').map((call) => call[2])
    ).toEqual([
      expect.objectContaining({
        text: '\x1b[200~feedback\x1b[201~',
        requireAgentStatus: 'sendable'
      }),
      expect.objectContaining({ enter: true, requireAgentStatus: 'sendable' })
    ])
  })
})
