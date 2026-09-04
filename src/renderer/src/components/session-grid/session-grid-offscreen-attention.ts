import type { SessionGridItem, SessionGridScrollMode } from '../../../../shared/session-grid-types'

/**
 * The two badges that mean "there is something here you have not seen": an agent asking, and
 * a turn nobody read. `working`/`monitoring` are busy, `done`/`interrupted` are outcomes —
 * neither is worth pulling the user away from the row they are on.
 *
 * Deliberately WIDER than the `attention` state chip, which is `permission` alone
 * (`sessionGridDotStateBucket`), and wider than the toolbar's Unread toggle, which is
 * `hasUnread` alone. Three surfaces, three questions: the chip filters by what the agent is
 * doing, the toggle by what you have not read, the pill points at either. That is why the
 * pill's copy says "unseen" and must borrow neither "Needs You" nor "Unread" — one word for
 * two different sets on one screen is the confusion all three exist to avoid. The test below
 * pins it.
 */
export function sessionGridItemNeedsAttention(
  item: Pick<SessionGridItem, 'attentionBadge'>
): boolean {
  return item.attentionBadge === 'permission' || item.attentionBadge === 'unread'
}

export type SessionGridOffscreenAttentionSide = {
  /** How many marked cards are out of view on this side. */
  count: number
  /** What to hand `scrollToPosition` to reach the nearest of them. */
  targetPosition: number
}

export type SessionGridOffscreenAttention = {
  above: SessionGridOffscreenAttentionSide | null
  below: SessionGridOffscreenAttentionSide | null
}

const NOTHING: SessionGridOffscreenAttention = { above: null, below: null }

/**
 * Which marked cards sit outside the rows on screen, purely from numbers the scroll hook
 * already publishes — no observers of its own, and no need for the card to be mounted: the
 * answer is an index, not an element.
 *
 * `mode` survives only for the TARGET: a position is a row in `row` mode and a page of rows
 * in the other two, so the same row is reached by a different number.
 */
export function resolveSessionGridOffscreenAttention({
  items,
  cols,
  rowsPerView,
  mode,
  firstVisibleRow
}: {
  items: readonly SessionGridItem[]
  cols: number
  rowsPerView: number
  mode: SessionGridScrollMode
  /**
   * From the scroll hook, not derived from its position: in `free` mode the position is a
   * ROUNDED page index over a continuous scroll, so deriving the window from it drifts by up
   * to half a viewport — enough to point at a card already on screen, or to say nothing about
   * one that is not.
   */
  firstVisibleRow: number
}): SessionGridOffscreenAttention {
  if (cols <= 0 || rowsPerView <= 0) {
    return NOTHING
  }
  const lastVisibleRow = firstVisibleRow + rowsPerView - 1

  let aboveCount = 0
  let belowCount = 0
  let nearestAboveRow = -1
  let nearestBelowRow = -1
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || !sessionGridItemNeedsAttention(item)) {
      continue
    }
    const row = Math.floor(index / cols)
    if (row < firstVisibleRow) {
      aboveCount += 1
      nearestAboveRow = Math.max(nearestAboveRow, row)
    } else if (row > lastVisibleRow) {
      belowCount += 1
      if (nearestBelowRow === -1) {
        nearestBelowRow = row
      }
    }
  }

  // The row itself in row mode; the page holding it otherwise. `scrollToPosition` clamps.
  const positionOf = (row: number): number => (mode === 'row' ? row : Math.floor(row / rowsPerView))
  return {
    above:
      aboveCount > 0 ? { count: aboveCount, targetPosition: positionOf(nearestAboveRow) } : null,
    below:
      belowCount > 0 ? { count: belowCount, targetPosition: positionOf(nearestBelowRow) } : null
  }
}
