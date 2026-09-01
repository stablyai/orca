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
