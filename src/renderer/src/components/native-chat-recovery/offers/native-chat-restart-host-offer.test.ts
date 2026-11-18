import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { awaitRestartHostLaunchContinuation } from './native-chat-restart-host-offer'

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

const call = vi.mocked(callStructuredAgentSession)

function failure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: '1', ok: false, error: { code, message: code } })
}

describe('waiting for the host to continue at launch', () => {
  beforeEach(() => call.mockReset())

  it('leaves continuing to this window only when the host predates it', async () => {
    call.mockRejectedValueOnce(failure('method_not_found'))
    expect(await awaitRestartHostLaunchContinuation({ kind: 'local' })).toBe('unsupported')

    for (const outcome of [undefined, failure('runtime_timeout'), new Error('closed')]) {
      if (outcome) {
        call.mockRejectedValueOnce(outcome)
      } else {
        call.mockResolvedValueOnce({ continuedSessionIds: [] })
      }
      expect(await awaitRestartHostLaunchContinuation({ kind: 'local' })).toBe('settled')
    }
  })
})
