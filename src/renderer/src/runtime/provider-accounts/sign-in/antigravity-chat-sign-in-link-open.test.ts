import { expect, it } from 'vitest'
import type { AntigravityChatSignInState } from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { opensAntigravityChatSignInLink } from './antigravity-chat-sign-in-status'

const FLOW = 'flow-1'
const waiting = (
  overrides: Partial<AntigravityChatSignInState> = {}
): AntigravityChatSignInState => ({
  flowId: FLOW,
  phase: 'waiting',
  url: 'https://accounts.google.com/o/oauth2/auth?state=s&response_type=code',
  ...overrides
})

it('opens the link this client started when the host leaves the browser to it', () => {
  expect(opensAntigravityChatSignInLink(waiting(), FLOW)).toBe(true)
  expect(opensAntigravityChatSignInLink(waiting({ openedByAgy: false }), FLOW)).toBe(true)
})

it("does not repeat the page agy opened on a local host", () => {
  expect(opensAntigravityChatSignInLink(waiting({ openedByAgy: true }), FLOW)).toBe(false)
})

it('leaves another client’s flow, an ended flow, and a linkless flow alone', () => {
  expect(opensAntigravityChatSignInLink(waiting(), 'other-flow')).toBe(false)
  expect(opensAntigravityChatSignInLink(waiting(), null)).toBe(false)
  expect(opensAntigravityChatSignInLink(waiting({ phase: 'verifying' }), FLOW)).toBe(false)
  expect(opensAntigravityChatSignInLink(waiting({ url: undefined }), FLOW)).toBe(false)
  // No flow id reaches this client for another's flow, and it may not act on it either.
  expect(opensAntigravityChatSignInLink(waiting({ flowId: null }), FLOW)).toBe(false)
})
