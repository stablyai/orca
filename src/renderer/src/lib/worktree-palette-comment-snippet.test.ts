import { describe, expect, it } from 'vitest'
import { extractWorktreePaletteCommentSnippet } from './worktree-palette-comment-snippet'

const EMOJI = '\u{1F680}'

// isWellFormed alone also accepts deleted emoji; require a contiguous source span to catch dropped characters.
function expectContiguousSlice(text: string, comment: string): void {
  const core = text.replace(/^\u2026/, '').replace(/\u2026$/, '')
  expect(comment).toContain(core)
}

describe('extractWorktreePaletteCommentSnippet', () => {
  it('highlights the match inside the returned text', () => {
    const comment = 'the reconnect work is blocked on infra'
    const matchStart = comment.indexOf('infra')
    const { text, matchRange } = extractWorktreePaletteCommentSnippet(
      comment,
      matchStart,
      matchStart + 'infra'.length
    )
    expect(text.slice(matchRange.start, matchRange.end)).toBe('infra')
  })

  // CJK exhausts both 10-step whitespace scans; sweep emoji across cuts to cover either split surrogate half.
  it('never splits a surrogate pair at the leading edge', () => {
    let keptEmoji = 0
    for (let offset = 0; offset < 40; offset += 1) {
      const comment = `${'词'.repeat(offset)}${EMOJI}${'词'.repeat(80 - offset)}目标${'词'.repeat(20)}`
      const matchStart = comment.indexOf('目标')
      const { text, matchRange } = extractWorktreePaletteCommentSnippet(
        comment,
        matchStart,
        matchStart + '目标'.length
      )
      expect(text.isWellFormed()).toBe(true)
      expect(text.slice(matchRange.start, matchRange.end)).toBe('目标')
      expectContiguousSlice(text, comment)
      if (text.includes(EMOJI)) {
        keptEmoji += 1
      }
    }
    // Require boundary iterations or dropping emoji every time would still pass the assertions above.
    expect(keptEmoji).toBeGreaterThan(0)
  })

  it('never splits a surrogate pair at the trailing edge', () => {
    let keptEmoji = 0
    for (let offset = 0; offset < 70; offset += 1) {
      const comment = `${'词'.repeat(20)}目标${'词'.repeat(offset)}${EMOJI}${'词'.repeat(90 - offset)}`
      const matchStart = comment.indexOf('目标')
      const { text, matchRange } = extractWorktreePaletteCommentSnippet(
        comment,
        matchStart,
        matchStart + '目标'.length
      )
      expect(text.isWellFormed()).toBe(true)
      expect(text.slice(matchRange.start, matchRange.end)).toBe('目标')
      expectContiguousSlice(text, comment)
      if (text.includes(EMOJI)) {
        keptEmoji += 1
      }
    }
    expect(keptEmoji).toBeGreaterThan(0)
  })
})
