import { expect, it } from 'vitest'
import { compareAppVersions } from './app-version'

it('orders prereleases by SemVer precedence without rounding legacy numeric identifiers', () => {
  expect(compareAppVersions('v4.2.0-rc.A.10', '4.2.0-rc.a.9')).toBeLessThan(0)
  expect(compareAppVersions('4.2.0-rc.9007199254740992', '4.2.0-rc.9007199254740993')).toBeLessThan(
    0
  )
  expect(compareAppVersions('04.2.0+local', '4.2.0+other')).toBe(0)
})
