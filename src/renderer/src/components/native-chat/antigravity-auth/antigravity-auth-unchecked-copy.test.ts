import { expect, it } from 'vitest'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { nativeChatSignInNoticeView } from '../host-access/native-chat-sign-in-notice'
import {
  antigravityAuthFailureReason,
  antigravityChatAuthAlternatives,
  antigravityChatAuthMenuItems
} from './antigravity-chat-auth-choices'

// Incident replay: agy's keychain item didn't answer in time, so Orca can't tell whether the
// Google login is there. Nothing may say it isn't, or offer to sign in.
const unchecked: AntigravityChatAuthDetection = {
  method: 'gemini-api-key',
  googleSignIn: { personal: false, business: false, personalUnchecked: true },
  apiKey: { available: true, source: 'saved' },
  adc: { available: false, project: null },
  liveChats: 0
}

it('marks the Google row "can’t check" in the sign-in method menu, never detected', () => {
  const google = antigravityChatAuthMenuItems(unchecked, true).find(
    (item) => item.method === 'oauth-personal'
  )
  expect(google).toMatchObject({ detected: false, unchecked: true })
})

it('never asks "Use your Google sign-in instead?" for a login it could not check', () => {
  expect(antigravityChatAuthAlternatives(unchecked)).not.toContainEqual({
    method: 'oauth-personal'
  })
})

it('never leads with "Antigravity isn\'t signed in." when the sign-out is unconfirmed', () => {
  expect(
    antigravityAuthFailureReason({
      failureKind: 'notSignedIn',
      text: 'Authentication required',
      signInUnconfirmed: true
    })
  ).toBeNull()
  // A confirmed sign-out still says so.
  expect(
    antigravityAuthFailureReason({ failureKind: 'notSignedIn', text: 'Authentication required' })
  ).toBe('signedOut')
})

it('words an unconfirmed sign-in failure as "can’t check", with no Sign in and no Settings link', () => {
  const view = nativeChatSignInNoticeView({
    kind: 'notSignedIn',
    agent: 'antigravity',
    setup: null,
    signInUnconfirmed: true
  })
  expect(view).toMatchObject({
    signedIn: false,
    button: null,
    steps: 'Not sent: can’t check Antigravity sign-in right now. Send again.'
  })
})

it('keeps Sign in on a confirmed sign-out', () => {
  const view = nativeChatSignInNoticeView({ kind: 'notSignedIn', agent: 'antigravity', setup: null })
  expect(view?.button).not.toBeNull()
})
