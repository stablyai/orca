import { describe, expect, it } from 'vitest'
import { isPosixAbsolutePath } from './terminal-path-normalization'

describe('isPosixAbsolutePath', () => {
  it('is true for POSIX absolute paths', () => {
    expect(isPosixAbsolutePath('/home/j/app/src/x.ts')).toBe(true)
    expect(isPosixAbsolutePath('/')).toBe(true)
  })

  it('is false for Windows drive and UNC paths', () => {
    expect(isPosixAbsolutePath('C:\\Users\\j\\app')).toBe(false)
    expect(isPosixAbsolutePath('\\\\wsl.localhost\\Ubuntu\\home\\j\\app')).toBe(false)
  })

  it('is false for relative or unparsable text', () => {
    expect(isPosixAbsolutePath('src/x.ts')).toBe(false)
    expect(isPosixAbsolutePath('')).toBe(false)
  })
})
