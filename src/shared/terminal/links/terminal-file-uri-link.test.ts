import { describe, expect, it } from 'vitest'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'

describe('detectTerminalFileUriLinks', () => {
  it('keeps standard unescaped parentheses and apostrophes inside the path', () => {
    const uri = "file:///tmp/Brennan's%20Report%20(final)"
    const [link] = detectTerminalFileUriLinks(`open (${uri})`)
    expect(link.pathText).toBe("/tmp/Brennan's Report (final)")
    expect(link.displayText).toBe(uri)
  })

  it('trims trailing sentence punctuation but keeps the extension', () => {
    const [link] = detectTerminalFileUriLinks('see file:///tmp/out.html.')
    expect(link.displayText).toBe('file:///tmp/out.html')
    expect(link.pathText).toBe('/tmp/out.html')
  })

  it('does not expose oversized terminal tokens to filesystem probing', () => {
    expect(detectTerminalFileUriLinks(`file:///tmp/${'a'.repeat(10_000)}`)).toEqual([])
  })
})
