import { describe, expect, it } from 'vitest'
import {
  compareAppVersions,
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion,
  isValidAppVersion
} from './app-version'

describe('app version comparison', () => {
  it('compares stable and prerelease versions with semver precedence', () => {
    expect(compareAppVersions('1.4.9', '1.5.0')).toBeLessThan(0)
    expect(compareAppVersions('1.5.0-rc.2', '1.5.0-rc.10')).toBeLessThan(0)
    expect(compareAppVersions('1.5.0-rc.10', '1.5.0')).toBeLessThan(0)
    expect(compareAppVersions('v1.5.0+build.2', '1.5.0+build.9')).toBe(0)
  })

  it('rejects incomplete versions and identifies prereleases', () => {
    expect(isValidAppVersion('1.5')).toBe(false)
    expect(isValidAppVersion('1.5.0')).toBe(true)
    expect(isPrereleaseAppVersion('1.5.0-rc.1')).toBe(true)
    expect(isPrereleaseAppVersion('1.5.0')).toBe(false)
    expect(isPerfPrereleaseAppVersion('1.5.0-rc.1.perf')).toBe(true)
    expect(isPerfPrereleaseAppVersion('1.5.0-rc.1')).toBe(false)
  })
})
