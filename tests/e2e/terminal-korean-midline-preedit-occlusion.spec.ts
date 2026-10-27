// #12545: an opaque mid-line preedit covered 하 but drew only 가; require every covered committed cell to be rendered.
// Compare real overlay/grid geometry; textContent and zero-rect DOM emulators cannot distinguish occlusion.
// CDP drives composition without native IME; write the grid directly because this tests drawing rather than PTY delivery.
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

// Sample once after nonzero readiness, before the live shell can repaint the composition row.
// Readiness must ignore the tail so it passes both builds and leaves occlusion as the discriminating assertion.
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

// Require every covered committed cell in rendered text; font metrics change the covered span, so exact tail text would pin the runner.
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
      // 안녕하세요 then CUB 6 places the cursor on 하 (two cells per syllable).
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요\x1b[6D')
      await setImeComposition(arena.session, '가')

      const sample = await sampleOpenComposition(orcaPage)
      expect(sample.cursorColumn, 'the cursor is not sitting on 하').toBe(4)
      expect(sample.rowTailFromCursor, 'the row under the overlay is not the repro').toBe('하세요')
      expect(sample.coveredColumns, 'the overlay covers no grid columns to assert about').not.toBe(
        null
      )

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
    // Pass before/after the fix to guard against drawing a tail where the row has none.
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
