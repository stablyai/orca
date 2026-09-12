import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { describePRCommentAckTarget } from './pr-comment-fixing-reply-body'

const comment = (body: string): PRComment => ({
  id: 1,
  author: 'alice',
  authorAvatarUrl: '',
  body,
  createdAt: '',
  url: ''
})
function originalSummary(body: string): string {
  const line = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/^[\s>#*\-_`]+/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .find((line) => line.length > 0)
  if (!line) {
    return 'comment'
  }
  return `comment — ${line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line}`
}
afterEach(() => vi.restoreAllMocks())

describe('review acknowledgement summary', () => {
  it.each([
    '',
    '\n\r\n\t',
    '# > ** _ - `\n\nReadable',
    '<!-- first\nsecond -->\n## Hello\r\nignored',
    'one<!-- hidden\nline -->two\nignored',
    '<!-- unclosed\nreadable',
    '<!-- outer <!-- inner -->visible -->',
    'a\rb\nc',
    '\u00a0##\u2028Hello\u2029world',
    'a'.repeat(71),
    'a'.repeat(72),
    'a'.repeat(73),
    `${'a'.repeat(70)}  b`,
    `${'a'.repeat(70)}😀tail`,
    '\n<!-- only metadata -->\n',
    'first\n<!-- tail\ncomment -->\nlast'
  ])('preserves the existing label for %j', (body) => {
    expect(describePRCommentAckTarget(comment(body))).toBe(originalSummary(body))
  })

  it('skips tail normalization and full-document line splitting', () => {
    const input = comment(`## Heading\n${'tail with   whitespace\n'.repeat(10_000)}`)
    const replace = vi.spyOn(String.prototype, 'replace')
    const split = vi.spyOn(String.prototype, 'split')
    const actual = describePRCommentAckTarget(input)
    const replaces = replace.mock.calls.length
    const splits = split.mock.calls.length
    expect(actual).toBe('comment — Heading')
    expect(replaces).toBe(2)
    expect(splits).toBe(0)
  })
})
