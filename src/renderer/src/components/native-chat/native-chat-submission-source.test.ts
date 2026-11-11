// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getConsentState } from '@/diagnostics/telemetry/telemetry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type * as RuntimeRpcModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { getCompiledSchema } from '../../../../main/schema-validation/zod-schema-compilation'
import {
  PtyChatSubmissionSummary,
  StructuredChatSubmissionSummary
} from '../../../../shared/rpc-contract/native-chat-submission-params'
import {
  readPtyChatPriorSubmission,
  readStructuredChatPriorSubmission,
  useNativeChatSubmissionHistory
} from './native-chat-submission-source'

vi.mock('@/diagnostics/telemetry/telemetry', () => ({ getConsentState: vi.fn() }))

beforeEach(() => vi.mocked(getConsentState).mockResolvedValue({ effective: 'enabled' }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const runtime = await importOriginal<typeof RuntimeRpcModule>()
  return { ...runtime, callRuntimeRpc: vi.fn(runtime.callRuntimeRpc) }
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

it('reads historical evidence through the RPC caller and compiled submission contracts', async () => {
  const schemas = {
    'agentSession.submissionSummary': getCompiledSchema(StructuredChatSubmissionSummary),
    'nativeChat.submissionSummary': getCompiledSchema(PtyChatSubmissionSummary)
  }
  vi.stubGlobal('window', {
    api: {
      runtime: {
        subscribe: async (
          request: { method: keyof typeof schemas; params: unknown },
          onResponse: (response: unknown) => void
        ) => {
          const parsed = schemas[request.method].safeParse(request.params)
          onResponse(
            parsed.success
              ? { ok: true, result: { hasPriorSubmission: true } }
              : { ok: false, error: { code: 'invalid_argument', message: 'Invalid params' } }
          )
          return { unsubscribe: () => {} }
        }
      }
    }
  })
  expect(
    await readStructuredChatPriorSubmission({
      target: { kind: 'local' },
      sessionId: 'conversation',
      before: { epoch: 'conversation', sequence: 200 }
    })
  ).toBe(true)
  expect(
    await readPtyChatPriorSubmission({
      target: { kind: 'local' },
      agent: 'claude',
      sessionId: 'conversation',
      messages: [
        { id: 'anchor', role: 'assistant', blocks: [], timestamp: 1, source: 'transcript' }
      ]
    })
  ).toBe(true)
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

it('keeps captured historical evidence readable after its composer unmounts', async () => {
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
  expect(await read).toBe(true)
})
