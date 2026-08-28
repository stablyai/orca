import type { Page } from '@stablyai/playwright-test'

/**
 * Measures what an active preedit overlay hides, against what it renders.
 *
 * The overlay has an opaque background and is absolutely positioned over the grid, so every cell
 * its bounding rect covers is unreadable for the duration of the composition. That gives one
 * invariant worth asserting on screen: **the overlay must render everything it covers**. Composing
 * mid-line broke it — the box covered the character at the cursor and rendered only the preedit.
 *
 * This has to be measured from the real rect against the real cell grid. The class, the
 * `textContent` and `display` are all identical either way, and a DOM emulator reports every rect
 * as zero, so a unit-level arm cannot see the difference.
 */
export type MidlinePreeditOcclusionSample = {
  /** Row text from the cursor rightwards — the committed characters a mid-line preedit sits over. */
  rowTailFromCursor: string
  /** Characters in the grid columns the overlay's bounding rect covers. */
  hiddenByOverlay: string
  /** Overlay text as rendered, LRM marks stripped. */
  overlayText: string
  overlayActive: boolean
  cursorColumn: number
  /** Columns covered by the overlay, as `[first, last]`; null when it covers none. */
  coveredColumns: [number, number] | null
  cellWidth: number
  /** Kept in the sample so a geometry mismatch prints the rects that produced it. */
  overlayRect: { left: number; right: number; width: number }
  screenRect: { left: number; width: number }
}

function readMidlinePreeditOcclusion(): MidlinePreeditOcclusionSample {
  const state = window.__store?.getState()
  const worktreeId = state?.activeWorktreeId
  const tabId =
    state?.activeTabType === 'terminal'
      ? state.activeTabId
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  const manager = tabId ? window.__paneManagers?.get(tabId) : null
  const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
  if (!pane) {
    throw new Error('No active terminal pane to sample')
  }
  const terminal = pane.terminal
  const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
  const view = pane.container.querySelector<HTMLElement>('.composition-view')
  if (!screen || !view) {
    throw new Error('Active terminal has no screen element or composition view')
  }

  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  const cursorColumn = buffer.cursorX
  const rowTailFromCursor = (line?.translateToString(true, cursorColumn) ?? '').trimEnd()

  const screenRect = screen.getBoundingClientRect()
  const overlayRect = view.getBoundingClientRect()
  const cellWidth = terminal.cols > 0 ? screenRect.width / terminal.cols : 0

  // A column counts as hidden when the overlay covers most of its cell, which keeps the sample
  // stable against the sub-pixel width a proportional text node lands on.
  let first: number | null = null
  let last = -1
  let hiddenByOverlay = ''
  if (cellWidth > 0 && overlayRect.width > 0) {
    for (let column = 0; column < terminal.cols; column++) {
      const cellLeft = screenRect.left + column * cellWidth
      const overlap =
        Math.min(cellLeft + cellWidth, overlayRect.right) - Math.max(cellLeft, overlayRect.left)
      if (overlap <= cellWidth / 2) {
        continue
      }
      first ??= column
      last = column
      hiddenByOverlay += line?.getCell(column)?.getChars() ?? ''
    }
  }

  return {
    rowTailFromCursor,
    hiddenByOverlay: hiddenByOverlay.trimEnd(),
    // The overlay wraps its text in LRM marks; strip them so assertions read as the user sees it.
    overlayText: (view.textContent ?? '').replaceAll('‎', ''),
    overlayActive: view.classList.contains('active'),
    cursorColumn,
    coveredColumns: first === null ? null : [first, last],
    cellWidth,
    overlayRect: {
      left: overlayRect.left,
      right: overlayRect.right,
      width: overlayRect.width
    },
    screenRect: { left: screenRect.left, width: screenRect.width }
  }
}

export async function sampleMidlinePreeditOcclusion(
  page: Page
): Promise<MidlinePreeditOcclusionSample> {
  return page.evaluate(readMidlinePreeditOcclusion)
}

/** Writes straight to the emulator: the defect is in what the overlay draws, not in the pty. */
export async function writeToActiveTerminal(page: Page, data: string): Promise<void> {
  await page.evaluate(async (payload: string) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to write to')
    }
    await new Promise<void>((resolve) => pane.terminal.write(payload, resolve))
  }, data)
}
