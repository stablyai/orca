import { describe, expect, it } from 'vitest'
import {
  requireChangelistId,
  requireChangelistTarget,
  requireDescription,
  requireRelativePath
} from './perforce-arguments'

describe('perforce argument validation', () => {
  it('accepts workspace-relative paths only', () => {
    expect(requireRelativePath('src/a.txt')).toContain('a.txt')
    expect(() => requireRelativePath('../etc/passwd')).toThrow()
    expect(() => requireRelativePath('/etc/passwd')).toThrow()
    expect(() => requireRelativePath('a\0b')).toThrow()
  })

  it('validates changelist numbers and targets', () => {
    expect(requireChangelistId(7)).toBe(7)
    expect(() => requireChangelistId('7')).toThrow()
    expect(() => requireChangelistId(0)).toThrow()
    expect(requireChangelistTarget('default')).toBe('default')
  })

  it('requires non-blank descriptions', () => {
    expect(requireDescription('  hi ', 'Description')).toBe('hi')
    expect(() => requireDescription('   ', 'Description')).toThrow('Description is required')
  })
})
