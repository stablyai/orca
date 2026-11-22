import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { botErrorMessage } from './bot-presentation'

describe('botErrorMessage', () => {
  it('names the agent release a refused bot chat needs', () => {
    // The host's reply when a bot's Hermes is older than chats support (#46746).
    const error = new RuntimeRpcCallError({
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
    })

    const message = botErrorMessage(error)

    expect(message).toContain('Hermes')
    expect(message).toContain('0.20.5')
    expect(message).toContain('0.23.0')
  })
})
