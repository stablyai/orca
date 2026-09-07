import { describe, expect, it } from 'vitest'
import { hasBinaryFileExtension } from './binary-file-extensions'

describe('hasBinaryFileExtension', () => {
  it('matches known binary extensions case-insensitively', () => {
    expect(hasBinaryFileExtension('docs/Shot.PNG')).toBe(true)
    expect(hasBinaryFileExtension('vendor/lib.tar.gz')).toBe(true)
    expect(hasBinaryFileExtension('C:\\assets\\theme.woff2')).toBe(true)
  })

  it('treats svg as text because the diff view renders its source', () => {
    expect(hasBinaryFileExtension('assets/map.svg')).toBe(false)
  })

  it('rejects text files, dotfiles, and extensionless paths', () => {
    expect(hasBinaryFileExtension('src/index.ts')).toBe(false)
    expect(hasBinaryFileExtension('.gitignore')).toBe(false)
    expect(hasBinaryFileExtension('scripts/.eslintrc')).toBe(false)
    expect(hasBinaryFileExtension('Makefile')).toBe(false)
    expect(hasBinaryFileExtension(undefined)).toBe(false)
  })

  it('does not match an extension that only appears in a directory name', () => {
    expect(hasBinaryFileExtension('build.zip/manifest')).toBe(false)
  })
})
