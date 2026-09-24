import { describe, expect, it } from 'vitest'
import { normalizeNativeFilePath } from './language-server-path-normalization'

describe('normalizeNativeFilePath', () => {
  it('uppercases the drive letter and flips slashes on Windows paths', () => {
    expect(normalizeNativeFilePath('d:\\zwf\\a\\b.cpp')).toBe('D:\\zwf\\a\\b.cpp')
    expect(normalizeNativeFilePath('D:/zwf/a/b.cpp')).toBe('D:\\zwf\\a\\b.cpp')
  })

  it('is idempotent for already-canonical Windows paths', () => {
    expect(normalizeNativeFilePath('D:\\zwf\\a\\b.cpp')).toBe('D:\\zwf\\a\\b.cpp')
  })

  it('leaves POSIX absolute paths untouched', () => {
    expect(normalizeNativeFilePath('/home/u/proj/a b/x.cpp')).toBe('/home/u/proj/a b/x.cpp')
    expect(normalizeNativeFilePath('/home/u/a:b.cpp')).toBe('/home/u/a:b.cpp')
  })
})
