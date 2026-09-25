/**
 * Headless end-to-end coverage for #22678: the composition caret follows the IME insertion point
 * inside an open preedit (Bopomofo / Japanese ←/→), without moving anything else.
 *
 * The insertion point is set through CDP `Input.imeSetComposition`'s selection, the same path
 * Chromium takes for native marked text, so this also pins that the helper textarea's selection
 * carries it. Geometry is read from real rects: moving the caret with layout (a negative margin)
 * instead of paint slid the row tail onto the preedit and shrank the end-of-row view, which a DOM
 * emulator cannot see.
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

const PREEDIT = '你好嗎'
/** Sub-pixel slack for rects measured against a fractional cell width. */
const TOLERANCE_PX = 1.5

/** Waits for the preedit, then polls until the deferred caret pass has placed the caret. */
async function sampleCaretAt(
  page: Page,
  cellsBeforeCaret: number
): Promise<MidlinePreeditOcclusionSample> {
  await expect
    .poll(
      async () => {
        const overlay = await samplePreeditOverlay(page)
        return overlay.active && overlay.rect.width > 0 && overlay.text.startsWith(PREEDIT)
      },
      { message: 'the preedit never reached the overlay at a non-zero size' }
    )
    .toBe(true)
  let sample = await sampleMidlinePreeditOcclusion(page)
  await expect
    .poll(
      async () => {
        sample = await sampleMidlinePreeditOcclusion(page)
        return caretLeftFromPreeditStart(sample) - cellsBeforeCaret * sample.cellWidth
      },
      { message: 'the caret never moved to the insertion point' }
    )
    .toBeCloseTo(0, 0)
  return sample
}

/** Where the caret's left edge sits, measured from the start of the preedit. */
function caretLeftFromPreeditStart(sample: MidlinePreeditOcclusionSample): number {
  if (!sample.caretRect || !sample.preeditRect) {
    return Number.NaN
  }
  return sample.caretRect.left - sample.preeditRect.left
}

/** The view clips with overflow: hidden, so a caret outside it is not drawn at all. */
function expectCaretInsideView(sample: MidlinePreeditOcclusionSample): void {
  const context = JSON.stringify(sample)
  expect(sample.caretRect, context).not.toBe(null)
  expect(
    sample.caretRect!.left,
    `the caret is clipped off the view's left edge — ${context}`
  ).toBeGreaterThanOrEqual(sample.overlayRect.left - 0.5)
  expect(
    sample.caretRect!.right,
    `the caret is clipped off the view's right edge — ${context}`
  ).toBeLessThanOrEqual(sample.overlayRect.right + 0.5)
}

test.describe('Terminal IME caret at the insertion point', () => {
  test('moves the caret mid-line without sliding the row tail onto the preedit', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[Hab XY\x1b[2D')
      // ← twice inside 你好嗎: the insertion point sits between 你 and 好.
      await setImeComposition(arena.session, PREEDIT, 1)

      const sample = await sampleCaretAt(orcaPage, 2)
      const context = JSON.stringify(sample)
      expect(sample.rowTailFromCursor, 'the row tail is not under the cursor').toBe('XY')
      expectCaretInsideView(sample)
      expect(sample.preeditRect, context).not.toBe(null)
      expect(sample.remainderRect, context).not.toBe(null)
      // The tail still starts after the whole preedit, not at the caret.
      expect(
        Math.abs(sample.remainderRect!.left - sample.preeditRect!.right),
        `the row tail overlaps the preedit — ${context}`
      ).toBeLessThanOrEqual(TOLERANCE_PX)
      expect(
        Math.abs(sample.preeditRect!.width - 6 * sample.cellWidth),
        `the preedit lost its width — ${context}`
      ).toBeLessThanOrEqual(TOLERANCE_PX)
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'ime-insertion-caret-midline', !completed)
    }
  })

  test('keeps the whole end-of-row preedit visible with the caret at its start', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[Hab ')
      await setImeComposition(arena.session, PREEDIT, 0)

      const sample = await sampleCaretAt(orcaPage, 0)
      const context = JSON.stringify(sample)
      expect(sample.rowTailFromCursor, 'text still sits after the cursor').toBe('')
      expectCaretInsideView(sample)
      expect(sample.preeditRect, context).not.toBe(null)
      // The flex view must not shrink below the preedit and clip the characters after the caret.
      expect(
        sample.overlayRect.width,
        `the view clips the preedit after the caret — ${context}`
      ).toBeGreaterThanOrEqual(sample.preeditRect!.width - TOLERANCE_PX)
      expect(
        Math.abs(sample.overlayRect.left - sample.preeditRect!.left),
        `the preedit does not start at the cursor — ${context}`
      ).toBeLessThanOrEqual(TOLERANCE_PX)
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'ime-insertion-caret-endofrow', !completed)
    }
  })
})
