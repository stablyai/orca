import { describe, expect, it } from 'vitest'
import { isValidNpmPackageName } from './npm-package-name'

describe('isValidNpmPackageName', () => {
  it('accepts ordinary and scoped registry names', () => {
    expect(isValidNpmPackageName('react')).toBe(true)
    expect(isValidNpmPackageName('lodash.merge')).toBe(true)
    expect(isValidNpmPackageName('@types/node')).toBe(true)
    expect(isValidNpmPackageName('@my-scope/my-pkg')).toBe(true)
  })

  it('rejects a name starting with a hyphen, which npm CLI would parse as a flag', () => {
    expect(isValidNpmPackageName('-evil-flag')).toBe(false)
    expect(isValidNpmPackageName('--silent')).toBe(false)
  })

  it('rejects scope path traversal', () => {
    expect(isValidNpmPackageName('@scope/../../etc')).toBe(false)
    expect(isValidNpmPackageName('@scope/../etc/passwd')).toBe(false)
  })

  it('rejects names containing a space, semicolon, or backtick', () => {
    expect(isValidNpmPackageName('evil pkg')).toBe(false)
    expect(isValidNpmPackageName('evil;rm -rf')).toBe(false)
    expect(isValidNpmPackageName('evil`whoami`')).toBe(false)
  })

  it('rejects URL-shaped names', () => {
    expect(isValidNpmPackageName('https://evil.example/pkg')).toBe(false)
    expect(isValidNpmPackageName('http://evil.example')).toBe(false)
  })

  it('rejects empty, oversized, and uppercase-containing names', () => {
    expect(isValidNpmPackageName('')).toBe(false)
    expect(isValidNpmPackageName('a'.repeat(215))).toBe(false)
    expect(isValidNpmPackageName('Evil')).toBe(false)
  })
})
