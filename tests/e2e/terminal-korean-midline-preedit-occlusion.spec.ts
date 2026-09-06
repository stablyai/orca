/**
 * Headless end-to-end coverage for #12545: a mid-line Korean composition must not swallow the
 * character after the cursor.
 *
 * The preedit overlay is an opaque, absolutely-positioned box over the grid, so every cell its
 * bounding rect covers is unreadable while the composition is open. That gives the invariant
 * asserted here — **the overlay renders every committed cell it covers** — and it is the one the
 * bug broke: the box covered `하` and drew only `가`. It is measured from the overlay's real rect
 * against the real cell grid, which is what makes it an on-screen assertion rather than a
 * `textContent` one; a DOM emulator reports every rect as zero and cannot see the difference.
 *
 * Reference terminal implementations do not settle this by geometry. Two mature ones compose marked
 * text into the grid rather than into a floating box, and both still blank the cells under it — so
 * moving off the overlay would not fix the report. Rendering the covered tail is what does.
 *
 * Composition is driven through CDP `Input.imeSetComposition`, so this runs in the normal headless
 * project with no native input source. The row is written straight to the emulator because the
 * defect is in what the overlay draws over the buffer, not in anything reaching the pty.
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

/**
 * Waits for the preedit to reach the overlay at a non-zero size, then samples once.
 *
 * Sampled once rather than polled: the pane runs a live shell that can repaint the row out from
 * under the composition, so only the frame the composition opened on carries the state the
 * assertion is about. The readiness gate is deliberately blind to the tail, so it holds identically
 * with and without the fix and the occlusion assertion is what discriminates.
 */
async function sampleOpenComposition(
  page: Page,
  expectedPreedit = '가'
): Promise<MidlinePreeditOcclusionSample> {
  await expect
    .poll(
      async () => {
        const overlay = await samplePreeditOverlay(page)
        return overlay.active && overlay.rect.width > 0 && overlay.text.startsWith(expectedPreedit)
      },
      { message: 'the preedit never reached the overlay at a non-zero size' }
    )
    .toBe(true)
  return sampleMidlinePreeditOcclusion(page)
}

/** Reads as one string so a failure prints what the overlay covered next to what it drew. */
function describeOcclusion(sample: MidlinePreeditOcclusionSample): string {
  return `covers ${JSON.stringify(sample.hiddenByOverlay)} / renders ${JSON.stringify(sample.overlayText)}`
}

/**
 * The invariant, stated so it survives a different cell width: every committed cell the overlay
 * covers must appear in what it draws. How MANY cells it covers is a function of the runner's
 * font metrics — 34.4px over an 8.43px grid spans four columns where an 8px grid spans two — so
 * asserting the covered text verbatim pins the machine, not the behaviour.
 */
function rendersEverythingItCovers(sample: MidlinePreeditOcclusionSample): boolean {
  return sample.overlayText.includes(sample.hiddenByOverlay)
}

test.describe('Terminal mid-line Korean preedit occlusion', () => {
  test('masks a semantically owned Codex placeholder during its first Korean preedit', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      const placeholder = 'Ask Codex to do anything'
      await writeToActiveTerminal(
        orcaPage,
        [
          '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7',
          `\x1b[2m${placeholder}\x1b[22m`,
          '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
        ].join('')
      )
      await setImeComposition(arena.session, '아')

      const sample = await sampleOpenComposition(orcaPage, '아')
      expect(sample.cursorColumn, 'the cursor is not after the Codex prompt').toBe(2)
      expect(sample.rowTailFromCursor, 'the Codex placeholder is not under the cursor').toBe(
        placeholder
      )
      expect(
        sample.hiddenByOverlay,
        `the opaque overlay does not mask the full placeholder — ${describeOcclusion(sample)}`
      ).toBe(placeholder)
      expect(sample.overlayText, 'the Codex placeholder is repeated after the preedit').toBe('아')
      expect(sample.remainderText, 'the hidden span lost the placeholder width').toBe(placeholder)
      expect(sample.remainderVisibility, 'the Codex placeholder is still painted').toBe('hidden')
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'korean-codex-placeholder-preedit',
        !completed
      )
    }
  })

  test('renders the row tail it covers, so the character after the cursor stays readable', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // The issue's repro: 안녕하세요, then CUB 6. Each Hangul syllable is two cells, so the
      // cursor lands on 하.
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요\x1b[6D')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.cursorColumn, 'the cursor is not sitting on 하').toBe(4)
      expect(sample.rowTailFromCursor, 'the row under the overlay is not the repro').toBe('하세요')
      expect(sample.coveredColumns, 'the overlay covers no grid columns to assert about').not.toBe(
        null
      )

      // The load-bearing assertion, and the only one that reads the overlay's geometry against the
      // grid: an opaque box that covers committed cells has to reproduce them, or the user loses
      // text for the length of the composition.
      expect(
        sample.hiddenByOverlay.length,
        `the overlay covers no committed text, so there is nothing to assert — ${describeOcclusion(sample)}`
      ).toBeGreaterThan(0)
      expect(
        rendersEverythingItCovers(sample),
        `the preedit overlay must render every committed cell it covers — ${describeOcclusion(sample)} ${JSON.stringify(sample)}`
      ).toBe(true)
      completed = true
    } finally {
      await closeTerminalImePaneArena(
        arena,
        testInfo,
        'korean-midline-preedit-occlusion',
        !completed
      )
    }
  })

  test('leaves the end-of-row composition untouched, with nothing covered to render', async ({
    orcaPage
  }, testInfo) => {
    // Passes before and after the fix by design: the guard is against over-correcting into
    // rendering a tail where the row has none.
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.rowTailFromCursor, 'text still sits after the cursor').toBe('')
      expect(
        describeOcclusion(sample),
        `an end-of-row composition covers no committed text — ${JSON.stringify(sample)}`
      ).toBe('covers "" / renders "가"')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-endofrow-preedit', !completed)
    }
  })
})
