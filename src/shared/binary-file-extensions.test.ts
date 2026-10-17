import { describe, expect, it } from 'vitest'
import { hasBinaryFileExtension, hasOsViewerOnlyFileExtension } from './binary-file-extensions'

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

describe('hasOsViewerOnlyFileExtension', () => {
  it('matches binaries the editor cannot display, case-insensitively', () => {
    expect(hasOsViewerOnlyFileExtension('media/Clip.MP4')).toBe(true)
    expect(hasOsViewerOnlyFileExtension('C:\\audio\\take.wav')).toBe(true)
    expect(hasOsViewerOnlyFileExtension('vendor/lib.tar.gz')).toBe(true)
    expect(hasOsViewerOnlyFileExtension('docs/deck.pptx')).toBe(true)
  })

  it('leaves images and PDFs to the editor viewers', () => {
    expect(hasOsViewerOnlyFileExtension('docs/Shot.PNG')).toBe(false)
    expect(hasOsViewerOnlyFileExtension('assets/icon.ico')).toBe(false)
    expect(hasOsViewerOnlyFileExtension('docs/spec.pdf')).toBe(false)
  })

  it('rejects executables and other loadable code', () => {
    for (const filePath of [
      'C:\\bin\\tool.EXE',
      'lib/x.dll',
      'lib/x.so',
      'lib/x.dylib',
      'app.jar',
      'm.node',
      'a.wasm'
    ]) {
      expect(hasOsViewerOnlyFileExtension(filePath)).toBe(false)
      expect(hasBinaryFileExtension(filePath)).toBe(true)
    }
  })

  it('rejects text, svg, dotfiles, and extensionless paths', () => {
    expect(hasOsViewerOnlyFileExtension('src/index.ts')).toBe(false)
    expect(hasOsViewerOnlyFileExtension('assets/map.svg')).toBe(false)
    expect(hasOsViewerOnlyFileExtension('.gitignore')).toBe(false)
    expect(hasOsViewerOnlyFileExtension('bin/run')).toBe(false)
    expect(hasOsViewerOnlyFileExtension(undefined)).toBe(false)
  })
})
