import { describe, expect, it } from 'vitest'
import { extractTerminalHttpLinks, TERMINAL_HTTP_URL_REGEX } from './terminal-http-url-extraction'

const urlsIn = (line: string): string[] => extractTerminalHttpLinks(line).map((link) => link.url)

describe('extractTerminalHttpLinks', () => {
  it('stops at a full-width parenthesis instead of swallowing the annotation', () => {
    expect(
      urlsIn('- PR: https://github.com/stablyai/orca/pull/12345（作成済み・マージ待ち）')
    ).toEqual(['https://github.com/stablyai/orca/pull/12345'])
  })

  it('stops at a full-width closing quote', () => {
    expect(urlsIn('詳細は「https://example.com/docs」を参照')).toEqual(['https://example.com/docs'])
  })

  it('stops at an ideographic space', () => {
    expect(urlsIn('PR: https://example.com/a　（全角スペース区切り）')).toEqual([
      'https://example.com/a'
    ])
  })

  it('keeps unencoded CJK letters that are genuinely part of the path', () => {
    // Why: wrapped URLs with Chinese path segments are supported; only punctuation ends a url.
    expect(urlsIn('https://example.com/文档/路径')).toEqual([
      new URL('https://example.com/文档/路径').toString()
    ])
  })

  it('stops at a full-width comma and full stop between a url and prose', () => {
    expect(urlsIn('https://example.com/a、次へ')).toEqual(['https://example.com/a'])
    expect(urlsIn('https://example.com/b。')).toEqual(['https://example.com/b'])
    expect(urlsIn('詳細はhttps://example.com/docs……')).toEqual(['https://example.com/docs'])
  })

  it.each([
    ['http://[::1]', 'http://[::1]'],
    ['see http://[::1]. now', 'http://[::1]'],
    ['Server at http://[::1]: ready', 'http://[::1]'],
    ['(http://user@[::1])', 'http://user@[::1]'],
    ['http://[::1]:5173/app]', 'http://[::1]:5173/app'],
    ['[see http://example.com/a[b]]', 'http://example.com/a[b']
  ])('keeps only an IPv6 host closing bracket in %j', (line, expected) => {
    // Why: xterm's WebLinksAddon matches with the regex; clicks and hard wraps use the extractor.
    expect(line.match(TERMINAL_HTTP_URL_REGEX)?.[0]).toBe(expected)
    expect(
      extractTerminalHttpLinks(line).map((link) => line.slice(link.startIndex, link.endIndex))
    ).toEqual([expected])
  })
})
