import { describe, expect, it } from 'vitest'
import { isTestSpecFile } from './test-spec-outline-gate'

describe('isTestSpecFile', () => {
  it('matches spec/test basenames for TS/JS only', () => {
    expect(isTestSpecFile('auth.spec.ts', 'typescript')).toBe(true)
    expect(isTestSpecFile('auth.test.tsx', 'typescript')).toBe(true)
    expect(isTestSpecFile('auth.spec.js', 'javascript')).toBe(true)
    expect(isTestSpecFile('src/auth.spec.ts', 'typescript')).toBe(true)
    expect(isTestSpecFile('utils.ts', 'typescript')).toBe(false)
    expect(isTestSpecFile('spec.md', 'markdown')).toBe(false)
    expect(isTestSpecFile('auth.spec.ts', 'plaintext')).toBe(false)
  })

  it('handles Windows separators', () => {
    expect(isTestSpecFile('C:\\repo\\auth.test.ts', 'typescript')).toBe(true)
  })
})
