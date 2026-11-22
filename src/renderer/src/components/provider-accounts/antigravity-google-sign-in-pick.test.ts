import { expect, it } from 'vitest'
import { antigravityGoogleSignInPick } from './AntigravityGoogleSignInChoice'

it('stores only an exact choice', () => {
  // A form's hidden select can report '' when the stored value changes to one with no option.
  expect(antigravityGoogleSignInPick('orca', 'orca', '')).toBeNull()
  expect(antigravityGoogleSignInPick('agy', 'agy', 'auto')).toBeNull()
})

it("doesn't pin the default by re-picking what already shows", () => {
  expect(antigravityGoogleSignInPick('auto', 'agy', 'agy')).toBeNull()
  expect(antigravityGoogleSignInPick('auto', 'orca', 'orca')).toBeNull()
  expect(antigravityGoogleSignInPick('auto', 'agy', 'orca')).toBe('orca')
})

it('stores a pick that differs from what is stored, even one matching what shows', () => {
  // agy is stored but can't apply (Orca's agy off, agy signed out), so Orca's shows.
  expect(antigravityGoogleSignInPick('agy', 'orca', 'orca')).toBe('orca')
  expect(antigravityGoogleSignInPick('orca', 'orca', 'agy')).toBe('agy')
})
