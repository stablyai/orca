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

  it('folds a WSL UNC path with forward slashes to backslashes (ticket 16 seam)', () => {
    // Why: a UNC built from a guest POSIX HOME carries forward slashes, but
    // Monaco's Uri.file().fsPath normalizes a UNC to backslashes; without
    // folding here the doc-sync bridge's owner match misses and didOpen never
    // reaches the WSL clangd session.
    expect(normalizeNativeFilePath('//wsl.localhost/Ubuntu/home/u/a.cpp')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\a.cpp'
    )
  })

  it('folds a mixed-separator WSL UNC path to backslashes', () => {
    expect(
      normalizeNativeFilePath('\\\\wsl.localhost\\Ubuntu-24.04/home/zwf\\repo\\main.cpp')
    ).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\zwf\\repo\\main.cpp')
  })

  it('accepts the legacy wsl$ share spelling', () => {
    expect(normalizeNativeFilePath('//wsl$/Ubuntu/home/u/a.cpp')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\u\\a.cpp'
    )
  })

  it('is idempotent for an already-backslash WSL UNC path', () => {
    const canonical = '\\\\wsl.localhost\\Ubuntu\\home\\u\\a.cpp'
    expect(normalizeNativeFilePath(canonical)).toBe(canonical)
  })

  it('preserves case in the WSL UNC path (the main process re-folds)', () => {
    // Why no case-fold here: this function also feeds filesystem ops
    // (authorizeExternalPath, openFile), which need the real spelling; the
    // main-process session key folds case via wslNormalizeKey.
    expect(normalizeNativeFilePath('//wsl.localhost/Ubuntu/Home/U/a.cpp')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\Home\\U\\a.cpp'
    )
  })

  it('leaves a plain POSIX path starting with // untouched (not a WSL share)', () => {
    expect(normalizeNativeFilePath('//home/u/a.cpp')).toBe('//home/u/a.cpp')
  })
})
