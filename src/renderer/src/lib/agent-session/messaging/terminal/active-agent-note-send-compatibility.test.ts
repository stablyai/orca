import { afterEach, expect, it, vi } from 'vitest'
import { sendPromptWithGuardedPasteAndEnter } from './active-agent-note-send-delivery'
import { forgetTerminalNoteDraft } from './active-agent-terminal-send-lane'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('../paste/agent-paste-draft', () => ({}))

afterEach(() => {
  forgetTerminalNoteDraft('released-pty')
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

it('lets only an explicit click recover a settled draft on a released host', async () => {
  vi.useFakeTimers()
  callRuntimeRpc.mockImplementation(async (_target, method) =>
    method === 'terminal.agentStatus'
      ? { agentStatus: { isRunningAgent: true, status: 'idle' } }
      : { send: { handle: 'released-terminal', accepted: true, bytesWritten: 1 } }
  )
  const target = { kind: 'environment', environmentId: 'released-host' } as const
  const options = { allowLegacyFallback: false, ptyId: 'released-pty' }
  for (const quote of Array.from({ length: 150 }, () => 'selection')) {
    await sendPromptWithGuardedPasteAndEnter(target, 'released-terminal', quote, {
      ...options,
      submit: false
    })
  }
  await expect(
    sendPromptWithGuardedPasteAndEnter(target, 'released-terminal', 'note', options)
  ).resolves.toMatchObject({ status: 'pasted' })
  const clicked = { ...options, userInitiated: true }
  await expect(
    sendPromptWithGuardedPasteAndEnter(target, 'released-terminal', 'too early', clicked)
  ).resolves.toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(
    sendPromptWithGuardedPasteAndEnter(target, 'released-terminal', 'automatic', options)
  ).resolves.toMatchObject({ status: 'not-ready', code: 'terminal-draft-pending' })
  const manual = sendPromptWithGuardedPasteAndEnter(
    target,
    'released-terminal',
    'clicked again',
    clicked
  )
  await vi.runAllTimersAsync()
  await expect(manual).resolves.toEqual({ status: 'sent' })
})
