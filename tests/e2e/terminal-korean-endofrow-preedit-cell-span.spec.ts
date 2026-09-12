/**
 * How many grid cells does an end-of-row preedit overlay actually occupy on screen?
 *
 * #12729 reported a black block over the last syllable of `가나다라`, and measured it at one cell
 * wide (14px against a 14px grid). We answer that report by saying the block is the preedit
 * overlay, not the cursor — but an overlay holding one Hangul syllable is shrink-to-fit around a
 * full-width glyph, so it should span about two cells, not one. That mismatch is the only measured
 * quantity in the report that argues against our explanation, and nothing in the unit suite can
 * settle it: `CompositionHelper` sets `maxWidth` but never `width`, so the rendered width comes
 * entirely from layout, and happy-dom reports every rect as zero.
 *
 * So this is the arm that measures it. If it fails, our answer to #12729 is wrong and the report's
 * one-cell measurement was right.
 *
 * The assertion is a floor, not a band. How many cells a syllable occupies is a function of the
 * runner's font metrics and fallback — the mid-line spec records a preedit measured at 34.4px over
 * an 8.43px grid, which is four cells, not two — so pinning "about two" would pin the machine. The
 * claim under test is only that the overlay is materially wider than the single cell the report
 * measured, which is what discriminates the overlay from the cursor.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import {
  sampleMidlinePreeditOcclusion,
  writeToActiveTerminal,
  type MidlinePreeditOcclusionSample
} from './terminal-ime-midline-occlusion-probe'
import { samplePreeditOverlay } from './terminal-ime-preedit-overlay-probe'

/** Below this the overlay is the one-cell block the report measured; above it, a full-width glyph. */
const MIN_CELLS_FOR_A_FULL_WIDTH_SYLLABLE = 1.5

/**
 * Waits for the preedit to reach the overlay at a non-zero size, then samples once — the pane runs
 * a live shell that can repaint the row, so only the frame the composition opened on carries the
 * state under assertion.
 */
async function sampleOpenComposition(page: Page): Promise<MidlinePreeditOcclusionSample> {
  await expect
    .poll(
      async () => {
        const overlay = await samplePreeditOverlay(page)
        return overlay.active && overlay.rect.width > 0 && overlay.text.startsWith('가')
      },
      { message: 'the preedit never reached the overlay at a non-zero size' }
    )
    .toBe(true)
  return sampleMidlinePreeditOcclusion(page)
}

function describeSpan(sample: MidlinePreeditOcclusionSample): string {
  const cells = sample.cellWidth > 0 ? sample.overlayRect.width / sample.cellWidth : 0
  return `overlay ${sample.overlayRect.width}px over a ${sample.cellWidth}px cell = ${cells.toFixed(2)} cells, covering columns ${JSON.stringify(sample.coveredColumns)}`
}

test.describe('Terminal end-of-row Korean preedit cell span', () => {
  test('keeps the preedit caret inside the final terminal cell', async ({ orcaPage }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // CHA clamps to the last column; xterm's wrap-pending cursor is the final-cell shape the
      // composition helper itself clamps onto.
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H\x1b[999Gx')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      const caret = sample.caretRect
      const preedit = sample.preeditRect
      const textarea = sample.textareaRect
      const screenRight = sample.screenRect.left + sample.screenRect.width
      expect(sample.cursorColumn, 'the cursor is not in the final column').toBe(
        sample.terminalColumns - 1
      )
      expect(sample.rowTailFromCursor, 'the final committed cell is not under the cursor').toBe('x')
      expect(sample.remainderText, 'the overlay lost the final committed cell').toBe('x')
      expect(sample.remainderDisplay, 'the impossible tail still clips the preedit caret').toBe(
        'none'
      )
      expect(sample.overlayText, 'the hidden tail still appears in the overlay').toBe('가')
      expect(caret, 'the active preedit has no caret element').not.toBeNull()
      expect(caret!.width, 'the preedit caret has zero width').toBeGreaterThan(0)
      expect(caret!.height, 'the preedit caret has zero height').toBeGreaterThan(0)
      expect(
        caret!.left,
        'the preedit caret is clipped left of its overlay'
      ).toBeGreaterThanOrEqual(sample.overlayRect.left - 0.5)
      expect(
        caret!.right,
        'the preedit caret overflows the terminal at the right edge'
      ).toBeLessThanOrEqual(screenRight + 0.5)
      expect(preedit, 'the active composition has no preedit element').not.toBeNull()
      expect(textarea.width, 'the IME candidate anchor has zero width').toBeGreaterThan(0)
      expect(
        textarea.left,
        'the IME candidate anchor overflows the terminal at the left edge'
      ).toBeGreaterThanOrEqual(sample.screenRect.left - 0.5)
      expect(
        textarea.right,
        'the IME candidate anchor overflows the terminal at the right edge'
      ).toBeLessThanOrEqual(screenRight + 0.5)
      expect(
        textarea.right,
        'the IME candidate anchor is not aligned with the preedit right edge'
      ).toBeCloseTo(preedit!.right, 0)
      expect(
        textarea.right,
        'the IME candidate anchor is not aligned with the caret right edge'
      ).toBeCloseTo(caret!.right, 0)
      expect(
        textarea.right,
        'the IME candidate anchor is not aligned with the terminal right edge'
      ).toBeCloseTo(screenRight, 0)
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'korean-right-edge-preedit-caret',
        !completed
      )
    }
  })

  test('renders a composing syllable wider than the one cell #12729 measured', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // 안녕하세요 is ten cells, so the cursor lands at the end of the row with nothing after it —
      // the shape #12729 hits, and the one where the overlay carries the preedit alone.
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.rowTailFromCursor, 'text still sits after the cursor').toBe('')
      expect(sample.cursorColumn, 'the cursor is not at the end of the committed run').toBe(10)
      expect(
        sample.cellWidth,
        'the grid reported no cell width to measure against'
      ).toBeGreaterThan(0)

      // The load-bearing assertion, and the one no unit arm can make: a preedit overlay holding a
      // full-width syllable is wider than a single cell, so the one-cell block in the report
      // cannot be an overlay rendering the same way this one does.
      expect(
        sample.overlayRect.width / sample.cellWidth,
        `a composing Hangul syllable must occupy more than one cell — ${describeSpan(sample)}`
      ).toBeGreaterThan(MIN_CELLS_FOR_A_FULL_WIDTH_SYLLABLE)
      expect(
        sample.coveredColumns,
        `the overlay covers no grid columns to assert about — ${describeSpan(sample)}`
      ).not.toBe(null)
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'korean-endofrow-preedit-cell-span',
        !completed
      )
    }
  })
})
