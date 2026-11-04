import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  adoptablePRs,
  clearPRRowsRead,
  isPRRead,
  markPRRowsRead,
  prReadKey,
  type PRReadMark
} from './pr-read-state'

const item = (overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem => ({
  id: 'PR_1',
  type: 'pr',
  number: 12,
  title: 'Add a thing',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/12',
  labels: [],
  updatedAt: '2026-11-01T10:00:00Z',
  author: 'ewen',
  repoId: 'repo-1',
  prRepo: { owner: 'Acme', repo: 'Widgets' },
  ...overrides
})

describe('prReadKey', () => {
  it('separates same-id rows from different repos and hosts', () => {
    const local = prReadKey(item())
    const otherRepo = prReadKey(item({ prRepo: { owner: 'Acme', repo: 'Gadgets' } }))
    const otherHost = prReadKey(item({ repoHostId: 'ssh:1' }))

    expect(new Set([local, otherRepo, otherHost]).size).toBe(3)
  })
})

describe('isPRRead', () => {
  it('reads an unmarked PR as unread', () => {
    expect(isPRRead({}, item())).toBe(false)
  })

  it('re-raises a read PR when it is updated again', () => {
    const marks = markPRRowsRead({}, [item()])

    expect(isPRRead(marks, item())).toBe(true)
    expect(isPRRead(marks, item({ updatedAt: '2026-11-02T10:00:00Z' }))).toBe(false)
  })

  it('re-raises a read PR when its checks start failing', () => {
    const green = item({
      checksSummary: { state: 'success', total: 2, passed: 2, failed: 0, pending: 0, neutral: 0 }
    })
    const marks = markPRRowsRead({}, [green])
    const red = item({
      checksSummary: { state: 'failure', total: 2, passed: 1, failed: 1, pending: 0, neutral: 0 }
    })

    expect(isPRRead(marks, green)).toBe(true)
    expect(isPRRead(marks, red)).toBe(false)
  })

  it('keeps a read PR read when checks settle to success', () => {
    const pending = item({
      checksSummary: { state: 'pending', total: 2, passed: 1, failed: 0, pending: 1, neutral: 0 }
    })
    const marks = markPRRowsRead({}, [pending])
    const green = item({
      checksSummary: { state: 'success', total: 2, passed: 2, failed: 0, pending: 0, neutral: 0 }
    })

    expect(isPRRead(marks, green)).toBe(true)
  })

  it('re-raises a read PR when it is merged or reopened', () => {
    const marks = markPRRowsRead({}, [item()])

    expect(isPRRead(marks, item({ state: 'merged' }))).toBe(false)
  })
})

describe('markPRRowsRead', () => {
  it('marks the PRs it is given and leaves the rest untouched', () => {
    const marks = markPRRowsRead({}, [item()])

    expect(Object.keys(marks)).toEqual([prReadKey(item())])
  })

  it('drops the oldest marks once the map is full', () => {
    const many = Array.from({ length: 501 }, (_, index) => item({ id: `PR_${index}` }))
    const marks = markPRRowsRead({}, many)

    expect(Object.keys(marks)).toHaveLength(500)
    expect(marks[prReadKey(many[0])]).toBeUndefined()
    expect(marks[prReadKey(many[500])]).toBeDefined()
  })

  it('returns the same map when there is nothing to mark', () => {
    const marks: Record<string, PRReadMark> = {}

    expect(markPRRowsRead(marks, [])).toBe(marks)
  })
})

describe('clearPRRowsRead', () => {
  it('makes a read PR unread again', () => {
    const marks = markPRRowsRead({}, [item()])
    const cleared = clearPRRowsRead(marks, [item()])

    expect(isPRRead(cleared, item())).toBe(false)
  })

  it('returns the same map when nothing was marked', () => {
    const marks = markPRRowsRead({}, [item()])

    expect(clearPRRowsRead(marks, [item({ id: 'PR_other' })])).toBe(marks)
  })
})

describe('adoptablePRs', () => {
  it('adopts only PRs that have never been marked', () => {
    const read = item({ id: 'PR_read' })
    const unmarked = item({ id: 'PR_unmarked' })
    const marks = markPRRowsRead({}, [read])

    expect(adoptablePRs(marks, [read, unmarked]).map((row) => row.id)).toEqual(['PR_unmarked'])
  })

  it('does not re-adopt a PR whose mark no longer matches, so existing activity stays unread', () => {
    const marks = markPRRowsRead({}, [item()])
    const moved = item({ updatedAt: '2026-11-02T10:00:00Z' })

    expect(adoptablePRs(marks, [moved])).toEqual([])
  })
})
