import { describe, expect, it } from 'vitest'
import {
  nativeChatAgySignedOutBeforeSend,
  nativeChatSignInAccount
} from './native-chat-sign-in-account'

const none = { unavailable: null, launchDetails: undefined, startFailures: [], submissions: [] }

describe('the account a chat signs in with', () => {
  it("is the one a refused send names, so agy's own Sign in is offered there", () => {
    const rejection = { kind: 'notSignedIn', account: 'system' } as const
    expect(
      nativeChatSignInAccount({
        ...none,
        submissions: [{ dispatchState: 'rejected', rejection }]
      })
    ).toBe('system')
  })

  it('is the one a failure line names when a failed start named none', () => {
    expect(
      nativeChatSignInAccount({
        ...none,
        launchDetails: { account: undefined },
        startFailures: [{ kind: 'notSignedIn', account: 'system' }]
      })
    ).toBe('system')
  })
})

describe("agy's sign-in before the first send", () => {
  it('is said while nothing was sent and the host knows agy is signed out', () => {
    expect(nativeChatAgySignedOutBeforeSend(true, [])).toEqual({
      reason: 'notSignedIn',
      account: 'system'
    })
  })

  it.each([
    ['once a message was sent', true, [{}]],
    ['when the host does not know', undefined, []],
    ['when agy is signed in', false, []]
  ])('is not said %s', (_case, signedOut, submissions) => {
    expect(nativeChatAgySignedOutBeforeSend(signedOut, submissions)).toBeNull()
  })
})
