import { describe, expect, it } from 'vitest'
import {
  computeGitGutterHunks,
  GIT_GUTTER_MAX_EDIT_DISTANCE,
  splitGitGutterLines
} from './git-gutter-line-diff'

function hunksFor(base: string, current: string) {
  return computeGitGutterHunks(splitGitGutterLines(base), splitGitGutterLines(current))
}

// Deterministic PRNG (mulberry32) so the LCS-oracle test below is reproducible in CI.
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomLines(random: () => number, alphabet: readonly string[]): string[] {
  const length = Math.floor(random() * 31)
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]!)
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0)
  )
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  return dp[a.length]![b.length]!
}

describe('splitGitGutterLines', () => {
  it('splits LF and CRLF the same way Monaco does', () => {
    expect(splitGitGutterLines('a\nb')).toEqual(['a', 'b'])
    expect(splitGitGutterLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('splits a lone carriage return like Monaco does', () => {
    expect(splitGitGutterLines('a\rb')).toEqual(['a', 'b'])
  })

  it('keeps the empty trailing element for a trailing newline', () => {
    expect(splitGitGutterLines('a\n')).toEqual(['a', ''])
  })

  it('treats empty text as a single empty line', () => {
    expect(splitGitGutterLines('')).toEqual([''])
  })
})

describe('computeGitGutterHunks', () => {
  it('reports nothing for identical content', () => {
    expect(hunksFor('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('reports nothing when only line endings differ', () => {
    expect(hunksFor('a\r\nb', 'a\nb')).toEqual([])
  })

  it('reports nothing for a CR-only file with identical content', () => {
    expect(computeGitGutterHunks(splitGitGutterLines('a\rb\rc'), ['a', 'b', 'c'])).toEqual([])
  })

  it('keeps an unchanged line between two insertions in separate hunks', () => {
    expect(hunksFor('a', 'b\na\nb')).toEqual([
      { kind: 'added', startLine: 1, endLine: 1 },
      { kind: 'added', startLine: 3, endLine: 3 }
    ])
  })

  it('marks appended lines as added', () => {
    expect(hunksFor('a\nb', 'a\nb\nc\nd')).toEqual([{ kind: 'added', startLine: 3, endLine: 4 }])
  })

  it('marks inserted lines in the middle as added', () => {
    expect(hunksFor('a\nd', 'a\nb\nc\nd')).toEqual([{ kind: 'added', startLine: 2, endLine: 3 }])
  })

  it('marks a replaced line as modified', () => {
    expect(hunksFor('a\nb\nc', 'a\nB\nc')).toEqual([{ kind: 'modified', startLine: 2, endLine: 2 }])
  })

  it('marks a replacement that grows as modified over the new lines', () => {
    expect(hunksFor('a\nb\nc', 'a\nB1\nB2\nc')).toEqual([
      { kind: 'modified', startLine: 2, endLine: 3 }
    ])
  })

  it('marks a deletion in the middle at the preceding line', () => {
    expect(hunksFor('a\nb\nc', 'a\nc')).toEqual([{ kind: 'deleted', afterLine: 1 }])
  })

  it('marks a deletion at the start of the file with afterLine 0', () => {
    expect(hunksFor('a\nb\nc', 'b\nc')).toEqual([{ kind: 'deleted', afterLine: 0 }])
  })

  it('marks a deletion at the end of the file', () => {
    expect(hunksFor('a\nb\nc', 'a\nb')).toEqual([{ kind: 'deleted', afterLine: 2 }])
  })

  it('reports separate hunks for changes far apart', () => {
    expect(hunksFor('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')).toEqual([
      { kind: 'modified', startLine: 1, endLine: 1 },
      { kind: 'modified', startLine: 5, endLine: 5 }
    ])
  })

  it('marks a whole new file as added', () => {
    expect(computeGitGutterHunks([], splitGitGutterLines('a\nb'))).toEqual([
      { kind: 'added', startLine: 1, endLine: 2 }
    ])
  })

  it('marks a fully emptied file as deleted before the first line', () => {
    expect(computeGitGutterHunks(splitGitGutterLines('a\nb'), [''])).toEqual([
      { kind: 'deleted', afterLine: 0 }
    ])
  })

  it('gives up rather than guessing when the edit distance is enormous', () => {
    const base = Array.from({ length: GIT_GUTTER_MAX_EDIT_DISTANCE + 50 }, (_, i) => `base-${i}`)
    const current = Array.from(
      { length: GIT_GUTTER_MAX_EDIT_DISTANCE + 50 },
      (_, i) => `current-${i}`
    )
    expect(computeGitGutterHunks(base, current)).toEqual([])
  })

  it('pins the cap boundary: exactly the max edit distance still diffs, one past it bails', () => {
    const half = GIT_GUTTER_MAX_EDIT_DISTANCE / 2
    const atCapBase = Array.from({ length: half }, (_, i) => `base-${i}`)
    const atCapCurrent = Array.from({ length: half }, (_, i) => `current-${i}`)
    expect(computeGitGutterHunks(atCapBase, atCapCurrent)).not.toEqual([])

    const overCapBase = Array.from({ length: half + 1 }, (_, i) => `base-${i}`)
    const overCapCurrent = Array.from({ length: half + 1 }, (_, i) => `current-${i}`)
    expect(computeGitGutterHunks(overCapBase, overCapCurrent)).toEqual([])
  })

  it('matches an LCS oracle on minimality over many deterministic random pairs', () => {
    const random = mulberry32(1234567)
    const alphabet = ['a', 'b', 'c', 'd']

    for (let i = 0; i < 300; i += 1) {
      const base = randomLines(random, alphabet)
      const current = randomLines(random, alphabet)
      const hunks = computeGitGutterHunks(base, current)
      const coveredLineCount = hunks.reduce(
        (sum, hunk) => (hunk.kind === 'deleted' ? sum : sum + (hunk.endLine - hunk.startLine + 1)),
        0
      )
      expect(current.length - coveredLineCount).toBe(lcsLength(base, current))
    }
  })
})
