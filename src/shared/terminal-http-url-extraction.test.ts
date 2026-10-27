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

  it('still extracts a plain ascii url and keeps its own punctuation', () => {
    expect(urlsIn('see https://example.com/a_b-c?d=1&e=2#f end')).toEqual([
      'https://example.com/a_b-c?d=1&e=2#f'
    ])
  })

  it('still trims ascii trailing punctuation', () => {
    expect(urlsIn('see https://example.com/a.')).toEqual(['https://example.com/a'])
  })

  it('gives the web-links hover the same url the extractor opens', () => {
    const webLinksUrlsIn = (line: string): string[] =>
      [...line.matchAll(new RegExp(TERMINAL_HTTP_URL_REGEX, 'gu'))].map((match) => match[0])
    for (const line of [
      '投稿はお願いします（https://github.com/stablyai/orca/pull/1078）。',
      '投稿はお願いします (https://github.com/stablyai/orca/pull/1078)。',
      '詳細は「https://example.com/docs」、https://example.com/b、次へ',
      'https://example.com/文档/路径。',
      'https://ja.wikipedia.org/wiki/ジョン・スミス、https://en.wikipedia.org/wiki/Michelson–Morley_experiment。',
      'see https://example.com/a_b-c?d=1&e=2#f.'
    ]) {
      expect(webLinksUrlsIn(line).map((url) => new URL(url).toString())).toEqual(urlsIn(line))
    }
  })
})
