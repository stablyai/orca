import { describe, expect, it } from 'vitest'
import {
  appendCommitMessageHistory,
  COMMIT_MESSAGE_HISTORY_LIMIT,
  commitMessageHistoryDirection,
  stepCommitMessageHistory
} from './commit-message-history'

describe('appendCommitMessageHistory', () => {
  it('trims and skips blank messages', () => {
    expect(appendCommitMessageHistory([], '  ')).toEqual([])
    expect(appendCommitMessageHistory([], ' fix parser ')).toEqual(['fix parser'])
  })

  it('skips only a back-to-back duplicate', () => {
    expect(appendCommitMessageHistory(['fix'], 'fix')).toEqual(['fix'])
    expect(appendCommitMessageHistory(['fix', 'feat'], 'fix')).toEqual(['fix', 'feat', 'fix'])
  })

  it('keeps the newest messages up to the cap', () => {
    const full = Array.from({ length: COMMIT_MESSAGE_HISTORY_LIMIT }, (_, index) => `m${index}`)
    const next = appendCommitMessageHistory(full, 'newest')
    expect(next).toHaveLength(COMMIT_MESSAGE_HISTORY_LIMIT)
    expect(next[0]).toBe('m1')
    expect(next.at(-1)).toBe('newest')
  })
})

describe('commitMessageHistoryDirection', () => {
  const collapsed = { selectionStart: 0, selectionEnd: 0 }

  it('starts Up on the first line and Down on the last line of a multi-line draft', () => {
    expect(commitMessageHistoryDirection({ key: 'ArrowUp', draft: 'one\ntwo', ...collapsed })).toBe(
      'back'
    )
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowUp',
        draft: 'one\ntwo',
        selectionStart: 5,
        selectionEnd: 5
      })
    ).toBeNull()
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowDown',
        draft: 'one\ntwo',
        selectionStart: 3,
        selectionEnd: 3
      })
    ).toBeNull()
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowDown',
        draft: 'one\ntwo',
        selectionStart: 7,
        selectionEnd: 7
      })
    ).toBe('forward')
  })

  it('leaves selections and modified arrows to the caret', () => {
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowUp',
        draft: 'fixed',
        selectionStart: 0,
        selectionEnd: 3
      })
    ).toBeNull()
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(
        commitMessageHistoryDirection({ key: 'ArrowUp', draft: '', ...collapsed, [modifier]: true })
      ).toBeNull()
    }
  })

  it('steps a recalled multi-line message from any caret line, but still leaves modified arrows', () => {
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowUp',
        draft: 'one\ntwo',
        selectionStart: 5,
        selectionEnd: 5,
        recallActive: true
      })
    ).toBe('back')
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowDown',
        draft: 'one\ntwo',
        selectionStart: 3,
        selectionEnd: 3,
        recallActive: true
      })
    ).toBe('forward')
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowUp',
        draft: 'one\ntwo',
        selectionStart: 5,
        selectionEnd: 5,
        recallActive: true,
        ctrlKey: true
      })
    ).toBeNull()
    expect(
      commitMessageHistoryDirection({
        key: 'ArrowUp',
        draft: 'one\ntwo',
        selectionStart: 0,
        selectionEnd: 3,
        recallActive: true
      })
    ).toBeNull()
  })

  it('ignores other keys', () => {
    expect(commitMessageHistoryDirection({ key: 'ArrowLeft', draft: '', ...collapsed })).toBeNull()
  })
})

describe('stepCommitMessageHistory', () => {
  const history = ['oldest', 'middle', 'newest']

  it('recalls the newest message from an empty draft, then walks back to the oldest', () => {
    const newest = stepCommitMessageHistory({
      direction: 'back',
      history,
      position: null,
      draft: ''
    })
    expect(newest).toEqual({ position: { index: 2, recalled: 'newest' }, draft: 'newest' })

    const middle = stepCommitMessageHistory({
      direction: 'back',
      history,
      position: newest?.position ?? null,
      draft: newest?.draft ?? ''
    })
    expect(middle?.draft).toBe('middle')

    const oldest = stepCommitMessageHistory({
      direction: 'back',
      history,
      position: middle?.position ?? null,
      draft: middle?.draft ?? ''
    })
    expect(oldest?.draft).toBe('oldest')

    expect(
      stepCommitMessageHistory({
        direction: 'back',
        history,
        position: oldest?.position ?? null,
        draft: oldest?.draft ?? ''
      })
    ).toBeNull()
  })

  it('walks forward and restores the empty draft past the newest message', () => {
    const middle = stepCommitMessageHistory({
      direction: 'forward',
      history,
      position: { index: 0, recalled: 'oldest' },
      draft: 'oldest'
    })
    expect(middle?.draft).toBe('middle')

    expect(
      stepCommitMessageHistory({
        direction: 'forward',
        history,
        position: { index: 2, recalled: 'newest' },
        draft: 'newest'
      })
    ).toEqual({ position: null, draft: '' })
  })

  it('never starts from a typed draft and exits recall once the recalled text is edited', () => {
    expect(
      stepCommitMessageHistory({ direction: 'back', history, position: null, draft: 'typed' })
    ).toBeNull()
    expect(
      stepCommitMessageHistory({ direction: 'forward', history, position: null, draft: 'typed' })
    ).toBeNull()
    expect(
      stepCommitMessageHistory({
        direction: 'back',
        history,
        position: { index: 2, recalled: 'newest' },
        draft: 'newest edited'
      })
    ).toBeNull()
  })

  it('returns null when there is no history', () => {
    expect(
      stepCommitMessageHistory({ direction: 'back', history: [], position: null, draft: '' })
    ).toBeNull()
  })
})
