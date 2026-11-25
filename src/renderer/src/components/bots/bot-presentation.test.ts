import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeRpcFailure } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { botErrorMessage } from './bot-presentation'

// The host's reply when a bot's Hermes is older than chats support (#46746).
const TOO_OLD_REPLY: RuntimeRpcFailure = {
  id: 'desktop-ipc',
  ok: false,
  error: {
    code: 'runtime_error',
    message: 'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.',
    data: {
      refusal: {
        code: 'structured_agent_session_unsupported',
        details: {
          reason: 'hostUnsupported',
          agentInstallation: {
            agent: 'hermes',
            installedVersion: '0.20.5',
            minimumVersion: '0.23.0'
          }
        }
      }
    }
  },
  _meta: { runtimeId: 'runtime-1' }
}

describe('botErrorMessage', () => {
  it('names the agent release a refused bot chat needs', () => {
    const message = botErrorMessage(new RuntimeRpcCallError(TOO_OLD_REPLY))

    expect(message).toContain('Hermes')
    expect(message).toContain('0.20.5')
    expect(message).toContain('0.23.0')
  })

  it('does not call a paired server this computer', () => {
    // The host's own words call itself this computer; a bot on a paired server is not this one.
    const error = new RuntimeRpcCallError(TOO_OLD_REPLY, {
      kind: 'environment',
      environmentId: 'env-1'
    })

    expect(botErrorMessage(error)).not.toContain('this computer')
  })
})

describe('botErrorMessage on invalid_argument', () => {
  const refusal = (message: string): RuntimeRpcCallError =>
    new RuntimeRpcCallError({
      id: 'desktop-ipc',
      ok: false,
      error: { code: 'invalid_argument', message },
      _meta: { runtimeId: 'runtime-1' }
    })
  const generic = 'Something went wrong. Try again.'

  it('shows a sentence the host worded for people', () => {
    expect(botErrorMessage(refusal("Run this from a bot's chat."))).toBe(
      "Run this from a bot's chat."
    )
  })

  it.each([
    'bot_not_found',
    'Too big: expected string to have <=200 characters',
    'invalid_argument',
    '   ',
    'Refused: tidy_now_busy happened.'
  ])('keeps the generic copy for %j', (message) => {
    expect(botErrorMessage(refusal(message))).toBe(generic)
  })
})
