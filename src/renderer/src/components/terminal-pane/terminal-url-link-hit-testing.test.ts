import { describe, expect, it } from 'vitest'
import { extractTerminalHttpLinks } from '../../../../shared/terminal-http-url-extraction'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from '../../../../shared/terminal-http-link-limits'

describe('extractTerminalHttpLinks', () => {
  it('extracts regular http links and trims terminal trailing punctuation', () => {
    const line = 'open https://example.com/path?x=1.'

    expect(extractTerminalHttpLinks(line)).toEqual([
      {
        url: 'https://example.com/path?x=1',
        startIndex: 'open '.length,
        endIndex: line.length - 1
      }
    ])
  })

  it('requires a word boundary before the http scheme', () => {
    expect(extractTerminalHttpLinks('prefixhttps://example.com/path')).toEqual([])
    expect(extractTerminalHttpLinks('prefix https://example.com/path')).toHaveLength(1)
  })

  it('rejects overlong pasted URL candidates before URL parsing', () => {
    const overlongUrl = `https://example.com/${'a'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH)}`

    expect(extractTerminalHttpLinks(overlongUrl)).toEqual([])
  })
})
