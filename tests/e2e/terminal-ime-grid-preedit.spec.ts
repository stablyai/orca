/**
 * Headless end-to-end coverage for the in-grid IME preedit (`imePreeditInGrid`, Orca's default).
 *
 * The preedit is drawn by the terminal renderer as cells on the cursor row, so what matters is
 * what the renderer's frame holds — the WebGL model or the DOM row — against what the buffer
 * holds. Every assertion reads the renderer through `terminal-ime-grid-preedit-probe.ts`.
 *
 * Composition is driven through CDP `Input.imeSetComposition`, so this runs in the headless
 * project with no native input source. Rows are written straight to the emulator: the preedit is
 * a rendering concern, and nothing it shows may reach the pty.
 */
import type { CDPSession, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import { writeToActiveTerminal } from './terminal-ime-midline-occlusion-probe'
import { sampleGridPreedit, type GridPreeditSample } from './terminal-ime-grid-preedit-probe'

/** Waits until the renderer's frame shows `preedit` in its cells, then samples once. */
async function sampleRenderedPreedit(page: Page, preedit: string): Promise<GridPreeditSample> {
  await expect
    .poll(
      async () => {
        const sample = await sampleGridPreedit(page)
        return sample.renderedText === preedit && sample.rendererMatchesDisplayedRow
      },
      { message: `the renderer never drew the preedit ${JSON.stringify(preedit)}` }
    )
    .toBe(true)
  return sampleGridPreedit(page)
}

async function setCompositionWithCaret(
  session: CDPSession,
  text: string,
  caret: number,
  selectionStart = caret
): Promise<void> {
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart,
    selectionEnd: caret
  })
}

test.describe('Terminal in-grid IME preedit', () => {
  test('draws a mid-line preedit into the row and pushes the committed tail right', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // #12545's repro: 안녕하세요, then CUB 6 puts the cursor on 하.
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요\x1b[6D')
      await setImeComposition(arena.session, '가')

      const sample = await sampleRenderedPreedit(orcaPage, '가')
      testInfo.annotations.push({ type: 'renderer', description: sample.renderer })
      expect(sample.inGrid, 'Orca terminals draw the preedit in the grid by default').toBe(true)
      expect(sample.displayedRow).toBe('안녕가하세요')
      expect(sample.bufferRow, 'the preedit must never enter the buffer').toBe('안녕하세요')
      expect(sample.startColumn).toBe(4)
      expect(sample.cursorColumn, 'the cursor sits after the preedit').toBe(6)
      expect(sample.rect.width).toBeGreaterThan(0)

      await setImeComposition(arena.session, '')
      await expect.poll(async () => (await sampleGridPreedit(orcaPage)).text).toBe('')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'grid-preedit-midline', !completed)
    }
  })

  test('replaces an owned composer placeholder instead of pushing it right', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(
        orcaPage,
        [
          '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7',
          '\x1b[2mAsk Codex to do anything\x1b[22m',
          '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
        ].join('')
      )
      await setImeComposition(arena.session, '아')

      const sample = await sampleRenderedPreedit(orcaPage, '아')
      expect(sample.displayedRow).toBe('› 아')
      expect(sample.bufferRow).toBe('› Ask Codex to do anything')
      await setImeComposition(arena.session, '')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'grid-preedit-placeholder', !completed)
    }
  })

  test('end-aligns a preedit at the right edge so the caret stays on screen', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      const cols = await orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        return window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.cols
      })
      await writeToActiveTerminal(orcaPage, `\x1b[2J\x1b[H${'x'.repeat(cols - 1)}`)
      await setImeComposition(arena.session, '한글')

      const sample = await sampleRenderedPreedit(orcaPage, '한글')
      expect(sample.startColumn).toBe(cols - 5)
      expect(sample.cursorColumn).toBe(cols - 1)
      // The preedit covers the committed cells it was pulled back over; the caret cell stays blank.
      expect(sample.displayedRow).toBe(`${'x'.repeat(cols - 5)}한글`)
      expect(sample.bufferRow).toBe('x'.repeat(cols - 1))
      await setImeComposition(arena.session, '')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'grid-preedit-right-edge', !completed)
    }
  })

  test('draws the cursor at the IME caret inside a converting phrase', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H> ')
      await setCompositionWithCaret(arena.session, '日本語', 1)

      await sampleRenderedPreedit(orcaPage, '日本語')
      await expect
        .poll(async () => (await sampleGridPreedit(orcaPage)).cursorColumn, {
          message: 'the cursor did not follow the IME caret'
        })
        .toBe(4)
      await setCompositionWithCaret(arena.session, '日本語', 3)
      await expect.poll(async () => (await sampleGridPreedit(orcaPage)).cursorColumn).toBe(8)
      // Clause conversion selects the active clause; the insertion point is its end.
      await setCompositionWithCaret(arena.session, '日本語', 2, 1)
      await expect
        .poll(async () => (await sampleGridPreedit(orcaPage)).cursorColumn, {
          message: 'the cursor did not follow the end of the selected clause'
        })
        .toBe(6)
      await setCompositionWithCaret(arena.session, '日本語', 1, 0)
      await expect.poll(async () => (await sampleGridPreedit(orcaPage)).cursorColumn).toBe(4)
      await setImeComposition(arena.session, '')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'grid-preedit-caret', !completed)
    }
  })

  test('reports per-update composition cost for the grid and overlay paths', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H안녕하세요\x1b[6D')
      const measure = (inGrid: boolean, flush: boolean): Promise<number> =>
        orcaPage.evaluate(
          async ({ grid, flush: flushEachUpdate }) => {
            const state = window.__store!.getState()
            const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
            const terminal = pane.terminal
            const textarea = terminal.textarea!
            const view = pane.container.querySelector<HTMLElement>('.composition-view')!
            terminal.options.imePreeditInGrid = grid
            const frames = ['ㅎ', '하', '한']
            const dispatch = (type: string, data: string): void => {
              const event = new CompositionEvent(type, { bubbles: true, data })
              textarea.dispatchEvent(event)
            }
            const iterations = 150
            dispatch('compositionstart', '')
            const started = performance.now()
            for (let index = 0; index < iterations; index++) {
              const data = frames[index % frames.length]!
              textarea.value = data
              dispatch('compositionupdate', data)
              // Optionally add what each path costs before a frame can show it: the grid paints its
              // row through the renderer, the overlay's rebuilt DOM must be laid out.
              if (flushEachUpdate && grid) {
                const row = terminal.buffer.active.cursorY
                terminal._core.refresh(row, row, true)
              } else if (flushEachUpdate) {
                view.getBoundingClientRect()
              }
            }
            const elapsed = (performance.now() - started) / iterations
            textarea.value = ''
            dispatch('compositionupdate', '')
            await new Promise((resolve) => setTimeout(resolve, 20))
            return elapsed
          },
          { grid: inGrid, flush }
        )
      // Warm both paths once so neither pays first-use font or atlas costs in the sample.
      await measure(false, true)
      await measure(true, true)
      const overlayMs = await measure(false, false)
      const gridMs = await measure(true, false)
      const overlayFlushedMs = await measure(false, true)
      const gridFlushedMs = await measure(true, true)
      const renderer = (await sampleGridPreedit(orcaPage)).renderer
      const report =
        `renderer ${renderer}; handler only: grid ${gridMs.toFixed(3)} / overlay ${overlayMs.toFixed(3)} ms; ` +
        `with render or layout flush: grid ${gridFlushedMs.toFixed(3)} / overlay ${overlayFlushedMs.toFixed(3)} ms`
      testInfo.annotations.push({ type: 'ime-preedit-update-cost', description: report })
      console.log(`[ime-preedit-update-cost] ${report}`)
      expect(
        [gridMs, overlayMs, gridFlushedMs, overlayFlushedMs].every((value) =>
          Number.isFinite(value)
        )
      ).toBe(true)
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'grid-preedit-update-cost', !completed)
    }
  })
})
