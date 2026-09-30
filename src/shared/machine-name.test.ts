import { describe, expect, it } from 'vitest'
import { MACHINE_NAME_MAX_LENGTH, normalizeMachineName } from './machine-name'

describe('normalizeMachineName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeMachineName('  Build server \n')).toBe('Build server')
  })

  it('caps the stored length after trimming', () => {
    const long = ` ${'x'.repeat(MACHINE_NAME_MAX_LENGTH + 20)} `
    expect(normalizeMachineName(long)).toHaveLength(MACHINE_NAME_MAX_LENGTH)
  })

  it('reads anything that is not a string as the detected-name default', () => {
    expect(normalizeMachineName(undefined)).toBe('')
    expect(normalizeMachineName(null)).toBe('')
    expect(normalizeMachineName(42)).toBe('')
    expect(normalizeMachineName('   ')).toBe('')
  })
})
