import { describe, expect, it } from 'vitest'
import type { GitBlameCommit } from '../../../../shared/git-blame-types'
import {
  formatGitBlameAge,
  formatGitBlameHoverMarkdown,
  formatGitBlameInlineText
} from './git-blame-annotation-format'

const NOW = Date.UTC(2026, 9, 19)
const DAY = 24 * 60 * 60 * 1000

function commit(overrides: Partial<GitBlameCommit> = {}): GitBlameCommit {
  return {
    sha: '0123456789abcdef0123456789abcdef01234567',
    author: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    authorTime: NOW - 3 * DAY,
    summary: 'fix: keep *stars* literal',
    uncommitted: false,
    ...overrides
  }
}

describe('git blame annotation format', () => {
  it('uses month and year units for old commits', () => {
    expect(formatGitBlameAge(NOW - 3 * DAY, NOW)).toBe('3 days ago')
    expect(formatGitBlameAge(NOW - 90 * DAY, NOW)).toBe('3 months ago')
    expect(formatGitBlameAge(NOW - 1200 * DAY, NOW)).toBe('3 years ago')
  })

  it('renders author, age, and a truncated summary inline', () => {
    expect(formatGitBlameInlineText(commit(), NOW)).toBe(
      'Ada Lovelace, 3 days ago • fix: keep *stars* literal'
    )
    const long = formatGitBlameInlineText(commit({ summary: 'x'.repeat(200) }), NOW)
    expect(long?.endsWith('…')).toBe(true)
    expect(long?.length).toBeLessThan(120)
  })

  it('drops the summary, then the whole annotation, as the free width shrinks', () => {
    expect(formatGitBlameInlineText(commit(), NOW, 45)).toBe(
      'Ada Lovelace, 3 days ago • fix: keep *stars*…'
    )
    expect(formatGitBlameInlineText(commit(), NOW, 30)).toBe('Ada Lovelace, 3 days ago')
    expect(formatGitBlameInlineText(commit(), NOW, 10)).toBeNull()
    expect(formatGitBlameInlineText(commit({ uncommitted: true }), NOW, 10)).toBeNull()
  })

  it('labels uncommitted lines instead of the placeholder author', () => {
    expect(formatGitBlameInlineText(commit({ uncommitted: true }), NOW)).toBe(
      'You • Uncommitted changes'
    )
  })

  it('escapes commit text in the hover so it cannot inject Markdown', () => {
    const hover = formatGitBlameHoverMarkdown(commit({ summary: '[click](https://x.test)' }), NOW)
    expect(hover).toContain('**Ada Lovelace**')
    expect(hover).toContain('\\<ada@example\\.com\\>')
    expect(hover).toContain('\\[click\\]\\(https://x\\.test\\)')
    expect(hover).toContain('`01234567`')
  })
})
