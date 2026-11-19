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

describe('structuredSessionNotices sign-in', () => {
  it('shows a not-signed-in start failure as its own sign-in row', () => {
    expect(notices(null)).toMatchObject([
      { key: 'launch', text: "Claude isn't signed in.", signIn: { signedIn: false } }
    ])
  })

  it('keeps an independent session error beside the sign-in row, without its button', () => {
    const shown = notices("Your draft couldn't be saved.")
    expect(shown.map((notice) => notice.key)).toEqual(['launch', 'session'])
    expect(shown[1]).toMatchObject({ text: "Your draft couldn't be saved." })
    expect(shown[1]?.signIn).toBeUndefined()
    expect(shown[1]?.action).toBeUndefined()
  })

  it('still shows the independent error once signed in', () => {
    const shown = notices("Your draft couldn't be saved.", true)
    expect(shown).toMatchObject([
      { key: 'launch', signIn: { signedIn: true } },
      { key: 'session', text: "Your draft couldn't be saved." }
    ])
  })
})
