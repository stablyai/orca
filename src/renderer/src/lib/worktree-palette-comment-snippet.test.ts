import { describe, expect, it } from 'vitest'
import { extractWorktreePaletteCommentSnippet } from './worktree-palette-comment-snippet'

const EMOJI = '\u{1F680}'

// Why not `isWellFormed` alone: it only proves no half-pair survived, which an
// implementation that DELETES the emoji satisfies just as well. The retained span must
// be a contiguous slice of the source, so nothing may be dropped out of its middle.
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

  // CJK carries no whitespace, so both boundary loops always exhaust their 10 iterations and
  // stop wherever the raw code-unit arithmetic put them — which can be mid-surrogate-pair.
  // Sweeping the emoji past the cut while the match stays put covers both halves of the pair.
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
    // Why: the boundary iterations are the point of the loop — if the snap dropped the
    // emoji on every one of them, the assertions above would still all pass.
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
