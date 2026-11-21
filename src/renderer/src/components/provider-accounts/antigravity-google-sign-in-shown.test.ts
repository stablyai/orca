import { expect, it } from 'vitest'
import { antigravityGoogleSignInInUse } from './AntigravityGoogleSignInChoice'

it('shows the sign-in new Google-account chats actually use, by the host answer', () => {
  // Orca's server is in use here and agy is signed in, so new chats run on agy (#44613).
  expect(antigravityGoogleSignInInUse({ chatUsesAgy: true })).toBe('agy')
  // Signed in through Orca's sign-in on the server, or agy not signed in.
  expect(antigravityGoogleSignInInUse({ chatUsesAgy: false })).toBe('orca')
  // The host hasn't answered yet, so the choice waits rather than guessing.
  expect(antigravityGoogleSignInInUse({})).toBeUndefined()
  expect(antigravityGoogleSignInInUse(null)).toBeUndefined()
})
