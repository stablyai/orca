import { expect, it } from 'vitest'
import { readHostOwnedSetting, resolveHostOwnedSetting } from './host-owned-settings'

it("reads a host's Google sign-in choice, defaulting to follow what the host has", () => {
  expect(readHostOwnedSetting({ antigravityGoogleSignIn: 'orca' }, 'antigravityGoogleSignIn')).toBe(
    'orca'
  )
  expect(resolveHostOwnedSetting({}, 'antigravityGoogleSignIn')).toBe('auto')
})

it('treats a host that reports no choice as one that cannot take it, so Settings hides it', () => {
  expect(readHostOwnedSetting({}, 'antigravityGoogleSignIn')).toBeUndefined()
  expect(
    readHostOwnedSetting({ antigravityGoogleSignIn: 'other' }, 'antigravityGoogleSignIn')
  ).toBeUndefined()
})
