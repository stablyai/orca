import { describe, expect, it } from 'vitest'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'

describe('detectTerminalFileUriLinks', () => {
  it('keeps standard unescaped parentheses and apostrophes inside the path', () => {
    const uri = "file:///tmp/Brennan's%20Report%20(final)"
    const [link] = detectTerminalFileUriLinks(`open (${uri})`)
    expect(link.pathText).toBe("/tmp/Brennan's Report (final)")
    expect(link.displayText).toBe(uri)
  })

  it('carries a :line:col suffix', () => {
    const [link] = detectTerminalFileUriLinks('file:///Users/dev/app.ts:12:3')
    expect(link).toMatchObject({ pathText: '/Users/dev/app.ts', line: 12, column: 3 })
  })

  it('carries an #Lline anchor', () => {
    const [link] = detectTerminalFileUriLinks('file:///Users/dev/app.ts#L42')
    expect(link).toMatchObject({ pathText: '/Users/dev/app.ts', line: 42, column: null })
  })

  it('strips the WHATWG leading slash before a Windows drive path', () => {
    const [link] = detectTerminalFileUriLinks('file:///C:/Users/dev/report.html')
    expect(link.pathText).toBe('C:/Users/dev/report.html')
  })

  it('trims trailing sentence punctuation but keeps the extension', () => {
    const [link] = detectTerminalFileUriLinks('see file:///tmp/out.html.')
    expect(link.displayText).toBe('file:///tmp/out.html')
    expect(link.pathText).toBe('/tmp/out.html')
  })

  it('rejects remote hosts (existence probing handles the path otherwise)', () => {
    expect(detectTerminalFileUriLinks('file://build-server/var/log/out.txt')).toEqual([])
  })

  it('ignores non-file schemes and malformed escapes', () => {
    expect(detectTerminalFileUriLinks('https://example.com/x.html')).toEqual([])
    expect(detectTerminalFileUriLinks('file:///tmp/%E0%A4%A.txt')).toEqual([])
  })

  it('does not expose oversized terminal tokens to filesystem probing', () => {
    expect(detectTerminalFileUriLinks(`file:///tmp/${'a'.repeat(10_000)}`)).toEqual([])
  })
})
