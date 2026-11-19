import { describe, expect, it } from 'vitest'
import type { NativeChatHostSetup } from '../../host-access/native-chat-host-setup'
import { structuredSessionNotices } from './native-chat-structured-session-notices'

function setup(signedIn: boolean): NativeChatHostSetup {
  return {
    signIn: { signingIn: false, signedIn, signIn: () => {} },
    install: null,
    host: { kind: 'local' }
  }
}

function notices(sessionError: string | null, signedIn = false) {
  return structuredSessionNotices({
    launch: {
      lifecycle: 'failed',
      failure: {
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn', account: 'managed' }
      },
      retry: () => {}
    },
    agentLabel: 'Claude',
    sessionError,
    composerError: null,
    setup: setup(signedIn)
  })
}

// An opaque stand-in: these tests follow the error through, not its wording.
const UNRELATED_ERROR = 'unrelated-session-error'

describe('structuredSessionNotices sign-in', () => {
  it('keeps an independent session error beside the sign-in row, without its button', () => {
    const shown = notices(UNRELATED_ERROR)
    expect(shown).toMatchObject([
      { key: 'launch', signIn: { signedIn: false } },
      { key: 'session', text: UNRELATED_ERROR }
    ])
    expect(shown[1]?.signIn).toBeUndefined()
    expect(shown[1]?.action).toBeUndefined()
  })

  it('still shows the independent error once signed in', () => {
    const shown = notices(UNRELATED_ERROR, true)
    expect(shown).toMatchObject([
      { key: 'launch', signIn: { signedIn: true } },
      { key: 'session', text: UNRELATED_ERROR }
    ])
  })
})
