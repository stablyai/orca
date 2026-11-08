// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getConsentState } from '@/lib/telemetry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  readPtyChatPriorSubmission,
  readStructuredChatPriorSubmission,
  useNativeChatSubmissionHistory
} from './native-chat-submission-source'

vi.mock('@/lib/telemetry', () => ({ getConsentState: vi.fn() }))

beforeEach(() => vi.mocked(getConsentState).mockResolvedValue({ effective: 'enabled' }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('does not accept historical submission evidence with telemetry disabled', async () => {
  vi.mocked(getConsentState).mockResolvedValue({ effective: 'disabled', reason: 'user_opt_out' })
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    hasPriorSubmission: true
  })
  expect(
    await readStructuredChatPriorSubmission({
      target: { kind: 'local' },
      sessionId: 'private-conversation',
      before: { epoch: 'conversation', sequence: 200 }
    })
  ).toBe(false)
})

it('discards PTY evidence when the conversation is cancelled during a read', async () => {
  const controller = new AbortController()
  const anchor = {
    id: 'earlier-user',
    role: 'user' as const,
    blocks: [],
    timestamp: 1,
    source: 'transcript' as const
  }
  const page = Promise.withResolvers<{ hasPriorSubmission: boolean }>()
  vi.mocked(callRuntimeRpc).mockReturnValue(page.promise)
  const read = readPtyChatPriorSubmission({
    target: { kind: 'local' },
    agent: 'codex',
    sessionId: 'cancelled-conversation',
    messages: [anchor],
    signal: controller.signal
  })
  controller.abort()
  page.resolve({ hasPriorSubmission: true })
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
})

it('discards a pending evidence read after its composer unmounts', async () => {
  const consent = Promise.withResolvers<{ effective: 'enabled' }>()
  vi.mocked(getConsentState).mockReturnValue(consent.promise)
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    hasPriorSubmission: true
  })
  const hook = renderHook(() => useNativeChatSubmissionHistory('conversation'))
  const read = hook.result.current.readPriorSubmission({
    key: 'conversation',
    readPriorSubmission: (signal) =>
      readStructuredChatPriorSubmission({
        target: { kind: 'local' },
        sessionId: 'conversation',
        before: { epoch: 'conversation', sequence: 200 },
        signal
      })
  })
  hook.unmount()
  consent.resolve({ effective: 'enabled' })
  expect(await read).toBe(false)
})
