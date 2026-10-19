import { describe, expect, it } from 'vitest'
import {
  normalizeScheduledMessage,
  normalizeScheduledMessages,
  validateScheduledMessageDraft
} from './scheduled-message-validation'
import { MAX_SCHEDULE_HORIZON_MS } from './scheduled-message-types'

const NOW = 1_700_000_000_000

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    worktreeId: 'repo::wt',
    text: 'hello',
    timing: { kind: 'at', sendAt: NOW },
    createdAt: NOW,
    status: 'pending',
    ...overrides
  }
}

describe('normalizeScheduledMessage', () => {
  it('accepts a well-formed row', () => {
    expect(normalizeScheduledMessage(validRow())).toMatchObject({
      id: 'msg-1',
      worktreeId: 'repo::wt',
      status: 'pending'
    })
  })

  it('rejects rows a hand-edited file could produce', () => {
    // Each of these would otherwise reach the terminal write path.
    expect(normalizeScheduledMessage(validRow({ text: 42 }))).toBeNull()
    expect(normalizeScheduledMessage(validRow({ worktreeId: '' }))).toBeNull()
    expect(normalizeScheduledMessage(validRow({ id: undefined }))).toBeNull()
    expect(normalizeScheduledMessage(validRow({ timing: { kind: 'at' } }))).toBeNull()
    expect(normalizeScheduledMessage(validRow({ timing: { kind: 'someday' } }))).toBeNull()
    expect(normalizeScheduledMessage(validRow({ createdAt: 'yesterday' }))).toBeNull()
    expect(normalizeScheduledMessage(null)).toBeNull()
  })

  it('drops a row whose status is present but unreadable', () => {
    // Defaulting it to pending would make a row of unknown delivery state
    // deliverable again, and the tick would type its text into the agent.
    expect(normalizeScheduledMessage(validRow({ status: 'weird' }))).toBeNull()
  })

  it('reads a row with no status at all as pending', () => {
    // A row written before the field existed, not a corrupt one.
    expect(normalizeScheduledMessage(validRow({ status: undefined }))).toMatchObject({
      status: 'pending'
    })
  })

  it('drops a failureReason that contradicts a pending status', () => {
    const row = normalizeScheduledMessage(validRow({ failureReason: 'no-pane' }))
    expect(row).not.toHaveProperty('failureReason')
  })

  it('keeps a failureReason on a failed row', () => {
    expect(
      normalizeScheduledMessage(validRow({ status: 'failed', failureReason: 'no-agent' }))
    ).toMatchObject({ status: 'failed', failureReason: 'no-agent' })
  })
})

describe('normalizeScheduledMessages', () => {
  it('drops bad rows and duplicate ids without losing the good ones', () => {
    const result = normalizeScheduledMessages([
      validRow({ id: 'a' }),
      { garbage: true },
      validRow({ id: 'a', text: 'duplicate' }),
      validRow({ id: 'b' })
    ])
    expect(result.map((row) => row.id)).toEqual(['a', 'b'])
    expect(result[0]?.text).toBe('hello')
  })

  it('returns an empty list for a non-array', () => {
    expect(normalizeScheduledMessages('nope')).toEqual([])
    expect(normalizeScheduledMessages(undefined)).toEqual([])
  })
})

describe('validateScheduledMessageDraft', () => {
  it('rejects whitespace-only text', () => {
    expect(
      validateScheduledMessageDraft({ text: '   \n ', timing: { kind: 'when-idle' } }, NOW)
    ).toBe('empty-text')
  })

  it('rejects a time in the past', () => {
    expect(
      validateScheduledMessageDraft({ text: 'hi', timing: { kind: 'at', sendAt: NOW - 1 } }, NOW)
    ).toBe('send-at-in-past')
  })

  it('rejects a time beyond the one-year horizon', () => {
    expect(
      validateScheduledMessageDraft(
        { text: 'hi', timing: { kind: 'at', sendAt: NOW + MAX_SCHEDULE_HORIZON_MS + 1 } },
        NOW
      )
    ).toBe('send-at-beyond-horizon')
  })

  it('accepts a when-idle draft with no time at all', () => {
    expect(validateScheduledMessageDraft({ text: 'hi', timing: { kind: 'when-idle' } }, NOW)).toBe(
      null
    )
  })
})
