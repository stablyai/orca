import { describe, expect, it } from 'vitest'
import {
  hasBinaryFileExtension,
  hasBinaryFileExtensionWithoutEditorViewer
} from './binary-file-extensions'

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
    expect(hasBinaryFileExtension('.png')).toBe(false)
    expect(hasBinaryFileExtension('scripts/.png')).toBe(false)
    expect(hasBinaryFileExtension('Makefile')).toBe(false)
    expect(hasBinaryFileExtension(undefined)).toBe(false)
  })

  it('does not match an extension that only appears in a directory name', () => {
    expect(hasBinaryFileExtension('build.zip/manifest')).toBe(false)
  })
})

describe('hasBinaryFileExtensionWithoutEditorViewer', () => {
  it('matches binaries the editor cannot display, case-insensitively', () => {
    expect(hasBinaryFileExtensionWithoutEditorViewer('media/Clip.MP4')).toBe(true)
    expect(hasBinaryFileExtensionWithoutEditorViewer('C:\\audio\\take.wav')).toBe(true)
    expect(hasBinaryFileExtensionWithoutEditorViewer('vendor/lib.tar.gz')).toBe(true)
    expect(hasBinaryFileExtensionWithoutEditorViewer('docs/deck.pptx')).toBe(true)
  })

  it('leaves images and PDFs to the editor viewers', () => {
    expect(hasBinaryFileExtensionWithoutEditorViewer('docs/Shot.PNG')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer('assets/icon.ico')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer('docs/spec.pdf')).toBe(false)
  })

  it('rejects text, svg, dotfiles, and extensionless paths', () => {
    expect(hasBinaryFileExtensionWithoutEditorViewer('src/index.ts')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer('assets/map.svg')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer('.gitignore')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer('bin/run')).toBe(false)
    expect(hasBinaryFileExtensionWithoutEditorViewer(undefined)).toBe(false)
  })
})
