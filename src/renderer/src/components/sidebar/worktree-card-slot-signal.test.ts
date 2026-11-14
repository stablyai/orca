import { describe, expect, it } from 'vitest'
import { titleRowSlot, titleRowUnread } from './worktree-card-slot-signal'

const base = {
  offline: false,
  collapsedLineage: [],
  workspaceUnread: null,
  ownLinesShown: true
}

describe('titleRowSlot quiet timestamp', () => {
  it('prefers newer workspace activity over an older acknowledged agent line', () => {
    const slot = titleRowSlot({
      ...base,
      lines: [{ kind: 'seen', at: 1_000 }],
      lastActivityAt: 5_000
    })
    expect(slot).toEqual({ kind: 'status', exceptions: [], at: 5_000 })
  })

  it('keeps a newer agent line over older workspace activity', () => {
    const slot = titleRowSlot({
      ...base,
      lines: [{ kind: 'seen', at: 9_000 }],
      lastActivityAt: 5_000
    })
    expect(slot).toMatchObject({ at: 9_000 })
  })

  it('takes newer lineage activity over its own', () => {
    const slot = titleRowSlot({
      ...base,
      lines: [{ kind: 'idle', at: 1_000 }],
      lastActivityAt: 2_000,
      lineageLatestAt: 3_000
    })
    expect(slot).toMatchObject({ at: 3_000 })
  })

  it('keeps the working start time even when workspace activity is newer', () => {
    const slot = titleRowSlot({
      ...base,
      ownLinesShown: false,
      lines: [{ kind: 'working', at: 1_000 }],
      lastActivityAt: 5_000
    })
    expect(slot).toMatchObject({ at: 1_000 })
  })

  it('returns null when nothing has a time', () => {
    expect(titleRowSlot({ ...base, lines: [], lastActivityAt: null })).toMatchObject({ at: null })
  })
})

it('keeps active work visible when collapsed descendants are monitoring', () => {
  expect(
    titleRowSlot({
      ...base,
      ownLinesShown: false,
      lines: [{ kind: 'working', at: 1_000 }],
      collapsedLineage: [{ kind: 'working', at: 2_000, monitoring: true }],
      lastActivityAt: null
    })
  ).toEqual({
    kind: 'status',
    exceptions: [{ kind: 'working', at: 2_000, monitoring: false }],
    at: 2_000
  })
})

describe('titleRowUnread', () => {
  const unreadChild = [{ kind: 'unread' as const, at: 1_000, manual: false }]

  it('keeps a collapsed child’s unread while the parent is offline', () => {
    // The offline slot drops every exception; the dot must not depend on it.
    expect(
      titleRowSlot({
        ...base,
        offline: true,
        collapsedLineage: unreadChild,
        lines: [],
        lastActivityAt: null
      })
    ).toEqual({ kind: 'offline' })
    expect(
      titleRowUnread({ lines: [], collapsedLineage: unreadChild, workspaceUnread: false })
    ).toBe(true)
  })

  it('is quiet with nothing unread', () => {
    expect(
      titleRowUnread({
        lines: [{ kind: 'seen', at: 1 }],
        collapsedLineage: [],
        workspaceUnread: false
      })
    ).toBe(false)
  })
})
