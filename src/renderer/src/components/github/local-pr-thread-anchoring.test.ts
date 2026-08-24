import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { anchorLineFromHunk, splitLocalThreadsForFile } from './local-pr-thread-anchoring'

function comment(overrides: Partial<PRComment> & { id: number }): PRComment {
  return {
    author: 'alice',
    authorAvatarUrl: '',
    body: `body ${overrides.id}`,
    createdAt: new Date(2026, 0, overrides.id).toISOString(),
    url: `https://github.com/o/r/pull/7#discussion_r${overrides.id}`,
    path: 'a.ts',
    threadId: `T${overrides.id}`,
    isResolved: false,
    line: 2,
    ...overrides
  }
}

const FILE = 'const one = 1\nconst two = 2\nconst three = 3'
const HUNK_LINE_2 = '@@ -1,3 +1,3 @@\n const one = 1\n+const two = 2'

function split(
  comments: PRComment[],
  context: { modifiedContent: string | null; headMatchesPrHead: boolean }
): ReturnType<typeof splitLocalThreadsForFile> {
  return splitLocalThreadsForFile({ comments, path: 'a.ts', repoId: 'repo', prNumber: 7, context })
}

describe('anchorLineFromHunk', () => {
  it('returns the last hunk line without its diff marker', () => {
    expect(anchorLineFromHunk(HUNK_LINE_2)).toBe('const two = 2')
    expect(anchorLineFromHunk('@@ -1 +1 @@\n context line')).toBe('context line')
  })

  it('returns null for missing or header-only hunks', () => {
    expect(anchorLineFromHunk(undefined)).toBeNull()
    expect(anchorLineFromHunk('@@ -1,3 +1,3 @@')).toBeNull()
  })

  it('strips a trailing carriage return (CRLF hunks)', () => {
    expect(anchorLineFromHunk('@@ -1 +1 @@\n+const two = 2\r')).toBe('const two = 2')
  })
})

describe('splitLocalThreadsForFile', () => {
  it('renders a thread inline when the anchor line still matches', () => {
    const { inline, outdated } = split([comment({ id: 1, diffHunk: HUNK_LINE_2 })], {
      modifiedContent: FILE,
      headMatchesPrHead: false
    })
    expect(inline).toHaveLength(1)
    expect(outdated).toHaveLength(0)
    expect(inline[0]).toMatchObject({ lineNumber: 2 })
  })

  it('moves a drifted thread into the outdated group', () => {
    const { inline, outdated } = split([comment({ id: 1, diffHunk: HUNK_LINE_2 })], {
      modifiedContent: 'const one = 1\nconst CHANGED = 9\nconst three = 3',
      headMatchesPrHead: true
    })
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(1)
    expect(outdated[0]?.reviewThread?.isOutdated).toBe(true)
  })

  it('tolerates CRLF differences between the hunk and the local file', () => {
    const { inline } = split([comment({ id: 1, diffHunk: HUNK_LINE_2 })], {
      modifiedContent: 'const one = 1\r\nconst two = 2\r\nconst three = 3',
      headMatchesPrHead: false
    })
    expect(inline).toHaveLength(1)
  })

  it('always groups LEFT-side threads as outdated', () => {
    const { inline, outdated } = split(
      [comment({ id: 1, diffHunk: HUNK_LINE_2, diffSide: 'LEFT' })],
      { modifiedContent: FILE, headMatchesPrHead: true }
    )
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(1)
  })

  it('groups LEFT-side threads as outdated even without a hunk', () => {
    const { inline, outdated } = split([comment({ id: 1, diffSide: 'LEFT' })], {
      modifiedContent: FILE,
      headMatchesPrHead: true
    })
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(1)
  })

  it('keeps server-flagged outdated threads outdated', () => {
    const { inline, outdated } = split([comment({ id: 1, isOutdated: true })], {
      modifiedContent: FILE,
      headMatchesPrHead: true
    })
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(1)
  })

  it('falls back to the head check when no hunk is available', () => {
    const withMatch = split([comment({ id: 1 })], {
      modifiedContent: FILE,
      headMatchesPrHead: true
    })
    expect(withMatch.inline).toHaveLength(1)
    const withoutMatch = split([comment({ id: 1 })], {
      modifiedContent: FILE,
      headMatchesPrHead: false
    })
    expect(withoutMatch.inline).toHaveLength(0)
    expect(withoutMatch.outdated).toHaveLength(1)
  })

  it('drifts the whole thread, replies included', () => {
    const { inline, outdated } = split(
      [
        comment({ id: 1, diffHunk: HUNK_LINE_2 }),
        comment({ id: 2, threadId: 'T1', diffHunk: undefined })
      ],
      { modifiedContent: 'nothing matches', headMatchesPrHead: false }
    )
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(1)
    expect(outdated[0]?.reviewThread?.replies).toHaveLength(1)
  })

  it('ignores comments for other files', () => {
    const { inline, outdated } = split([comment({ id: 1, path: 'b.ts', diffHunk: HUNK_LINE_2 })], {
      modifiedContent: FILE,
      headMatchesPrHead: true
    })
    expect(inline).toHaveLength(0)
    expect(outdated).toHaveLength(0)
  })
})
