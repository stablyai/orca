import { describe, expect, it } from 'vitest'
import { normalizeMachineName } from './machine-name'

describe('normalizeMachineName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeMachineName('  Build server \n')).toBe('Build server')
  })

  it('caps the stored length after trimming', () => {
    expect(normalizeMachineName(` ${'x'.repeat(255)} `)).toBe('x'.repeat(255))
    expect(normalizeMachineName(` ${'x'.repeat(256)} `)).toBe('x'.repeat(255))
  })

  it('reads anything that is not a string as the detected-name default', () => {
    expect(normalizeMachineName(undefined)).toBe('')
    expect(normalizeMachineName(null)).toBe('')
    expect(normalizeMachineName(42)).toBe('')
    expect(normalizeMachineName('   ')).toBe('')
  })
})
