import { describe, expect, it } from 'vitest'

import {
  clipboardTextIsCopiedFileNames,
  couldClipboardTextBeCopiedFileNames,
  parseClipboardFileUriList,
  parseMacOsFilenamesPropertyList
} from './clipboard-file-paths'

function makeFilenamesPropertyList(paths: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<array>',
    ...paths.map((path) => `\t<string>${path}</string>`),
    '</array>',
    '</plist>'
  ].join('\n')
}

describe('parseMacOsFilenamesPropertyList', () => {
  it('reads every path from a multi-file Finder copy', () => {
    expect(
      parseMacOsFilenamesPropertyList(
        makeFilenamesPropertyList(['/Users/me/project/App.tsx', '/Users/me/notes/spec.md'])
      )
    ).toEqual(['/Users/me/project/App.tsx', '/Users/me/notes/spec.md'])
  })

  it('decodes XML entities in file names', () => {
    expect(
      parseMacOsFilenamesPropertyList(
        makeFilenamesPropertyList(['/Users/me/a &amp; b/r&#233;sum&#233;.txt'])
      )
    ).toEqual(['/Users/me/a & b/résumé.txt'])
  })

  it('drops relative entries and non-list payloads', () => {
    expect(
      parseMacOsFilenamesPropertyList(makeFilenamesPropertyList(['relative/path.txt']))
    ).toEqual([])
    expect(
      parseMacOsFilenamesPropertyList('<plist><string>/Users/me/a.txt</string></plist>')
    ).toEqual([])
  })
})

describe('parseClipboardFileUriList', () => {
  it('reads a KDE-style text/uri-list', () => {
    expect(
      parseClipboardFileUriList('file:///home/me/a.txt\r\nfile:///home/me/b%20c.txt\r\n')
    ).toEqual(['/home/me/a.txt', '/home/me/b c.txt'])
  })

  it('skips the GNOME copy verb line and comments', () => {
    expect(parseClipboardFileUriList('copy\n# comment\nfile:///home/me/a.txt')).toEqual([
      '/home/me/a.txt'
    ])
  })

  it('reads a Windows drive path from a file URL', () => {
    expect(parseClipboardFileUriList('file:///C:/Users/Name/My%20Project/file.txt')).toEqual([
      'C:/Users/Name/My Project/file.txt'
    ])
  })

  it('ignores non-file schemes', () => {
    expect(parseClipboardFileUriList('https://example.com/a.txt')).toEqual([])
  })

  it('ignores the macOS file reference URL Finder puts on public.file-url', () => {
    expect(parseClipboardFileUriList('file:///.file/id=6571367.71479400')).toEqual([])
  })
})

describe('couldClipboardTextBeCopiedFileNames', () => {
  it('accepts empty text and bare display names', () => {
    expect(couldClipboardTextBeCopiedFileNames('')).toBe(true)
    expect(couldClipboardTextBeCopiedFileNames('App.tsx')).toBe(true)
    expect(couldClipboardTextBeCopiedFileNames('App.tsx\nspec.md')).toBe(true)
  })

  it('rejects text that carries path separators, tabs, padding, or blank lines', () => {
    expect(couldClipboardTextBeCopiedFileNames('/Users/me/App.tsx')).toBe(false)
    expect(couldClipboardTextBeCopiedFileNames('C:\\Users\\me\\App.tsx')).toBe(false)
    expect(couldClipboardTextBeCopiedFileNames('a\tb')).toBe(false)
    expect(couldClipboardTextBeCopiedFileNames(' App.tsx')).toBe(false)
    expect(couldClipboardTextBeCopiedFileNames('App.tsx\n\nspec.md')).toBe(false)
  })

  it('rejects long prose that happens to have no separator', () => {
    expect(couldClipboardTextBeCopiedFileNames('x'.repeat(256))).toBe(false)
  })
})

describe('clipboardTextIsCopiedFileNames', () => {
  it('matches the display names of the copied files', () => {
    expect(clipboardTextIsCopiedFileNames('App.tsx', ['/Users/me/project/App.tsx'])).toBe(true)
    expect(
      clipboardTextIsCopiedFileNames('App.tsx\nspec.md', [
        '/Users/me/project/App.tsx',
        '/Users/me/notes/spec.md'
      ])
    ).toBe(true)
    expect(clipboardTextIsCopiedFileNames('', ['/Users/me/project/App.tsx'])).toBe(true)
  })

  it('keeps real text that is unrelated to the copied files', () => {
    expect(clipboardTextIsCopiedFileNames('deploy now', ['/Users/me/project/App.tsx'])).toBe(false)
    expect(clipboardTextIsCopiedFileNames('App.tsx\nApp.tsx', ['/Users/me/project/App.tsx'])).toBe(
      false
    )
  })
})
