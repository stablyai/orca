import { describe, expect, it } from 'vitest'
import {
  resolveSessionGridOffscreenAttention,
  sessionGridItemNeedsAttention
} from './session-grid-offscreen-attention'
import { offscreenAttentionLabel } from './SessionGridOffscreenAttentionPill'
import { agentStateLabel } from '../dashboard-popout/agent-dashboard-filter-options'
import {
  sessionGridDotStateBucket,
  type SessionGridAttentionBadge,
  type SessionGridItem,
  type SessionGridScrollMode
} from '../../../../shared/session-grid-types'

function card(index: number, attentionBadge: SessionGridAttentionBadge | null): SessionGridItem {
  return {
    tabId: `tab-${index}`,
    ptyId: null,
    paneKey: null,
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repoName: 'repo',
    worktreeName: 'wt',
    title: `Session ${index}`,
    dotState: 'idle',
    hasUnread: attentionBadge === 'unread',
    attentionBadge,
    isHiddenFromGrid: false,
    createdAt: index,
    hostKind: 'local',
    executionHostId: 'local',
    cwd: '/repo',
    shellOverride: undefined,
    launchAgent: undefined
  }
}

/** A 2-column grid showing 2 rows: 4 cards on screen, indices 0-3 on the first page. */
function grid(
  badgesByIndex: Record<number, SessionGridAttentionBadge>,
  total: number
): SessionGridItem[] {
  return Array.from({ length: total }, (_, i) => card(i, badgesByIndex[i] ?? null))
}

/** `firstVisibleRow` is the topmost row on screen — what the scroll hook measures. */
function resolve(
  items: SessionGridItem[],
  mode: SessionGridScrollMode,
  firstVisibleRow: number
): ReturnType<typeof resolveSessionGridOffscreenAttention> {
  return resolveSessionGridOffscreenAttention({
    items,
    cols: 2,
    rowsPerView: 2,
    mode,
    firstVisibleRow
  })
}

describe('sessionGridItemNeedsAttention', () => {
  it.each([
    ['permission', true],
    ['unread', true],
    ['working', false],
    ['monitoring', false],
    ['done', false],
    ['interrupted', false]
  ] satisfies [SessionGridAttentionBadge, boolean][])(
    'counts %s as needing you: %s',
    (badge, expected) => {
      expect(sessionGridItemNeedsAttention({ attentionBadge: badge })).toBe(expected)
    }
  )

  it('does not count a quiet card', () => {
    expect(sessionGridItemNeedsAttention({ attentionBadge: null })).toBe(false)
  })
})

describe('resolveSessionGridOffscreenAttention', () => {
  it('says nothing while every marked card is on screen', () => {
    // Indices 0-3 are rows 0-1, which is the whole viewport at position 0.
    expect(resolve(grid({ 1: 'permission', 3: 'unread' }, 4), 'row', 0)).toEqual({
      above: null,
      below: null
    })
  })

  it('points down at a marked card below the visible rows, and counts them', () => {
    // Rows 0-1 visible; index 8 is row 4 and index 11 is row 5.
    const attention = resolve(grid({ 8: 'permission', 11: 'unread' }, 12), 'row', 0)

    expect(attention.above).toBeNull()
    expect(attention.below).toEqual({ count: 2, targetPosition: 4 })
  })

  it('points up once the marked card is behind the viewport', () => {
    const attention = resolve(grid({ 0: 'permission' }, 12), 'row', 4)

    expect(attention.below).toBeNull()
    expect(attention.above).toEqual({ count: 1, targetPosition: 0 })
  })

  it('aims at the nearest one on each side, not the first it finds', () => {
    // Rows 4-5 visible. Above: rows 0 and 3 → 3. Below: rows 6 and 9 → 6.
    const attention = resolve(
      grid({ 0: 'unread', 6: 'unread', 13: 'permission', 19: 'permission' }, 20),
      'row',
      4
    )

    expect(attention.above).toEqual({ count: 2, targetPosition: 3 })
    expect(attention.below).toEqual({ count: 2, targetPosition: 6 })
  })

  it('ignores busy and finished cards, which are not asking for anything', () => {
    expect(resolve(grid({ 8: 'working', 10: 'done', 11: 'interrupted' }, 12), 'row', 0)).toEqual({
      above: null,
      below: null
    })
  })

  // The window is always rows; only the TARGET changes with the mode, because a position is
  // a row in `row` mode and a page of rows in the other two.
  it.each(['page', 'free'] satisfies SessionGridScrollMode[])(
    'targets the page holding the row in %s mode',
    (mode) => {
      const items = grid({ 8: 'permission' }, 12)

      // Rows 0-1 on screen; index 8 is row 4, reached by page 2.
      expect(resolve(items, mode, 0).below).toEqual({ count: 1, targetPosition: 2 })
      // Rows 4-5 on screen: the same card is in view.
      expect(resolve(items, mode, 4)).toEqual({ above: null, below: null })
      // Rows 6-7: it is behind us, and page 2 goes back to it.
      expect(resolve(items, mode, 6).above).toEqual({ count: 1, targetPosition: 2 })
    }
  )

  /**
   * Free mode scrolls continuously, so its first visible row is NOT page-aligned. Deriving the
   * window from the rounded page index put the fold half a viewport off: at row 3 of a 2-row
   * view, `round(3/2) = 2` claims rows 4-5 are on screen, so a card on row 4 gets no pill and
   * a card on row 2 gets one it does not need. Every case here is a row a page never lands on.
   */
  it('reads an unaligned free-mode window exactly, not to the nearest page', () => {
    const items = grid({ 4: 'permission', 14: 'unread' }, 20)

    // Rows 3-4 on screen: index 4 is row 2 — behind us — and index 14 is row 7, below.
    expect(resolve(items, 'free', 3)).toEqual({
      above: { count: 1, targetPosition: 1 },
      below: { count: 1, targetPosition: 3 }
    })
    // One row further and row 2 is still behind, row 7 still below.
    expect(resolve(items, 'free', 5).above).toEqual({ count: 1, targetPosition: 1 })
    // Rows 7-8: the lower card (row 7) is genuinely on screen now, so only the upper is left.
    expect(resolve(items, 'free', 7)).toEqual({
      above: { count: 1, targetPosition: 1 },
      below: null
    })
  })

  it('says nothing rather than dividing by zero before the grid is measured', () => {
    const items = grid({ 8: 'permission' }, 12)

    expect(
      resolveSessionGridOffscreenAttention({
        items,
        cols: 0,
        rowsPerView: 2,
        mode: 'row',
        firstVisibleRow: 0
      })
    ).toEqual({ above: null, below: null })
    expect(
      resolveSessionGridOffscreenAttention({
        items,
        cols: 2,
        rowsPerView: 0,
        mode: 'row',
        firstVisibleRow: 0
      })
    ).toEqual({ above: null, below: null })
  })
})

/**
 * The pill and the `attention` chip count different sets on purpose, so they must not claim
 * the same words. Saying "2 sessions below need you" and then showing 0 under a chip labelled
 * "Needs You" — which also hides the two cards the pill pointed at — is one contradiction a
 * user meets a screen apart, and nothing else in the codebase would catch it.
 */
describe('the pill does not borrow the state chip’s vocabulary', () => {
  const CHIP_LABEL = agentStateLabel('attention')

  it('counts a wider set than the chip it must not imitate', () => {
    expect(sessionGridItemNeedsAttention({ attentionBadge: 'unread' })).toBe(true)
    // The chip's own bucket disagrees about that very card: unread is not `attention`.
    expect(sessionGridDotStateBucket('done')).not.toBe('attention')
  })

  it.each([
    ['above', 1],
    ['above', 3],
    ['below', 1],
    ['below', 3]
  ] as const)('keeps the chip’s phrase out of the %s pill (%i)', (direction, count) => {
    const label = offscreenAttentionLabel(direction, count).toLowerCase()

    expect(label).not.toContain(CHIP_LABEL.toLowerCase())
    // The phrase, not just the exact label: "need you" is what makes the promise.
    expect(label).not.toContain('need you')
    expect(label).not.toContain('needs you')
    // ...and it still says which way and how many.
    expect(label).toContain(direction)
    expect(label).toContain(String(count))
  })
})
