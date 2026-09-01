import { describe, expect, it } from 'vitest'
import { classifyNpmVersionDrift } from './npm-version-drift'

describe('classifyNpmVersionDrift', () => {
  it('reports same when installed equals latest', () => {
    expect(classifyNpmVersionDrift('1.2.3', '1.2.3')).toBe('same')
  })

  it('reports patch when only the patch component differs', () => {
    expect(classifyNpmVersionDrift('1.2.3', '1.2.9')).toBe('patch')
  })

  it('reports minor when the minor component differs', () => {
    expect(classifyNpmVersionDrift('1.2.3', '1.5.0')).toBe('minor')
  })

  it('reports major when the major component differs', () => {
    expect(classifyNpmVersionDrift('1.0.0', '3.0.0')).toBe('major')
  })

  it('reports prerelease when only the prerelease identifier differs on an otherwise equal core', () => {
    expect(classifyNpmVersionDrift('1.2.3-rc.1', '1.2.3')).toBe('prerelease')
  })

  it('reports unknown when either version does not parse as semver', () => {
    expect(classifyNpmVersionDrift('workspace:*', '1.2.3')).toBe('unknown')
    expect(classifyNpmVersionDrift('1.2.3', 'not-a-version')).toBe('unknown')
  })
})

describe('classifyNpmVersionDrift when the installed version is ahead', () => {
  // Why: `latest` can lag what is installed — a `next`/prerelease install, a
  // linked local build, or a dist-tag that has not moved yet. Reporting
  // "major update available" to someone who is ahead is worse than silence.
  it.each([
    ['20.0.0', '19.2.8'],
    ['19.3.0', '19.2.8'],
    ['19.2.9', '19.2.8']
  ])('does not report an update for installed %s against latest %s', (installed, latest) => {
    expect(classifyNpmVersionDrift(installed, latest)).toBe('unknown')
  })

  it('still reports the severity when the installed version is genuinely behind', () => {
    expect(classifyNpmVersionDrift('18.2.0', '19.2.8')).toBe('major')
  })
})
