import { expect, it } from 'vitest'
import { AntigravityAccountTargetParams } from './antigravity-accounts-params'
it('accepts optional verified bindings but refuses malformed or unknown request fields', () => {
  expect(
    AntigravityAccountTargetParams.parse({
      runtime: 'wsl',
      wslDistro: null,
      expectedAuthorityId: 'a'.repeat(64)
    }).expectedAuthorityId
  ).toBe('a'.repeat(64))
  expect(() =>
    AntigravityAccountTargetParams.parse({ runtime: 'wsl', expectedAuthorityId: 'invalid' })
  ).toThrow()
  expect(() => AntigravityAccountTargetParams.parse({ runtime: 'host', unknown: true })).toThrow()
  expect(AntigravityAccountTargetParams.parse({ runtime: 'host' })).toEqual({ runtime: 'host' })
})
