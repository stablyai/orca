import { expect, it } from 'vitest'
import { antigravityGoogleSignInShown } from './AntigravityGoogleSignInChoice'

it('shows the sign-in in use while the host follows its default, and an explicit choice as made', () => {
  // An upgraded profile signed in through Orca's sign-in on the server.
  expect(antigravityGoogleSignInShown('auto', 'orca')).toBe('orca')
  expect(antigravityGoogleSignInShown('auto', 'agy')).toBe('agy')
  expect(antigravityGoogleSignInShown('agy', 'orca')).toBe('agy')
  expect(antigravityGoogleSignInShown('orca', 'agy')).toBe('orca')
})
