import { expect, it } from 'vitest'
import {
  antigravityKeySaveSignsIn,
  antigravityServerAccountRowShown
} from './antigravity-server-account-row'

const onAgy = { noServerAccount: true, alert: null, reauth: false, pickedMethod: 'gemini-api-key' }

it('shows the row as before where key chats run on the server', () => {
  expect(antigravityServerAccountRowShown({ ...onAgy, noServerAccount: false })).toBe(true)
})

it('hides it on agy, even when the form still remembers a Google sign-in from load', () => {
  expect(antigravityServerAccountRowShown(onAgy)).toBe(false)
  // Switched from a Google sign-in to the key: no "Sign in again to use Gemini API key".
  expect(antigravityServerAccountRowShown({ ...onAgy, reauth: true })).toBe(false)
})

it('keeps a failed save, and a sign-in for a method picked here that signs in', () => {
  expect(antigravityServerAccountRowShown({ ...onAgy, alert: 'Could not save.' })).toBe(true)
  expect(
    antigravityServerAccountRowShown({ ...onAgy, reauth: true, pickedMethod: 'oauth-personal' })
  ).toBe(true)
})

it('signs the server in after a key save only while key chats run there', () => {
  expect(antigravityKeySaveSignsIn('gemini-api-key', false)).toBe(true)
  // On agy the server isn't used, and starting its sign-in would fail where it isn't installed.
  expect(antigravityKeySaveSignsIn('gemini-api-key', true)).toBe(false)
  expect(antigravityKeySaveSignsIn('oauth-personal', false)).toBe(false)
})
