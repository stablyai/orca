import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import {
  sampleMidlinePreeditOcclusion,
  writeToActiveTerminal
} from './terminal-ime-midline-occlusion-probe'

type TerminalGrid = {
  _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } }
}

for (const dpr of [1, 1.25, 2]) {
  for (const gpu of ['on', 'off'] as const) {
    test.describe(`IME preedit grid DPR ${dpr} GPU ${gpu}`, () => {
      test.use({ orcaAppExtraArgs: [`--force-device-scale-factor=${dpr}`] })

      test('matches committed character advances across font and spacing changes', async ({
        orcaPage,
        electronApp
      }, testInfo) => {
        await electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].setSize(1920, 1080)
        })
        const arena = await openTerminalImePaneArena(orcaPage)
        let completed = false
        try {
          for (const options of [
            { fontSize: 13, letterSpacing: 0 },
            { fontSize: 14, letterSpacing: 0 },
            { fontSize: 13, letterSpacing: 1 }
          ]) {
            await orcaPage.evaluate(
              ({ gpu, options }) => {
                const state = window.__store!.getState()
                const manager = window.__paneManagers!.get(state.activeTabId!)!
                manager.setTerminalGpuAcceleration(gpu)
                const terminal = manager.getActivePane()!.terminal
                terminal.options.fontFamily = 'monospace'
                terminal.options.fontSize = options.fontSize
                terminal.options.letterSpacing = options.letterSpacing
              },
              { gpu, options }
            )

            for (const text of ['あ'.repeat(32), 'あｱカタカナ・コーヒー', '한글中文']) {
              await writeToActiveTerminal(orcaPage, `\x1b[2J\x1b[H${text}\r\n`)
              await setImeComposition(arena.session, text)
              const preedit = orcaPage.locator(
                '.composition-view.active .xterm-composition-preedit'
              )
              await expect(preedit).toHaveText(`‎${text}‎`)

              const sample = await orcaPage.evaluate(() => {
                const state = window.__store!.getState()
                const terminal = window
                  .__paneManagers!.get(state.activeTabId!)!
                  .getActivePane()!.terminal
                const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
                const preedit = screen.querySelector<HTMLElement>('.xterm-composition-preedit')!
                // The canvas width rounds independently of fractional WebGL cell widths.
                const cellWidth = (terminal as unknown as TerminalGrid)._core._renderService
                  .dimensions.css.cell.width
                const line = terminal.buffer.active.getLine(terminal.buffer.active.baseY)!
                const committed: { text: string; column: number; width: number }[] = []
                const end = line.translateToString(true).length
                let seen = 0
                let columns = 0
                for (let column = 0; column < terminal.cols && seen < end; column++) {
                  const cell = line.getCell(column)!
                  if (cell.getWidth() > 0) {
                    committed.push({ text: cell.getChars(), column, width: cell.getWidth() })
                    seen += cell.getChars().length
                    columns = column + cell.getWidth()
                  }
                }
                const starts: number[] = []
                const walker = document.createTreeWalker(preedit, NodeFilter.SHOW_TEXT)
                let node: Node | null
                let index = 0
                while ((node = walker.nextNode())) {
                  const value = node.textContent ?? ''
                  for (let offset = 0; offset < value.length;) {
                    if (value[offset] === '‎') {
                      offset++
                      continue
                    }
                    const cellText = committed[index++]?.text
                    if (!cellText || !value.startsWith(cellText, offset)) {
                      throw new Error('Preedit text does not match the committed buffer cells')
                    }
                    const range = document.createRange()
                    range.setStart(node, offset)
                    range.setEnd(node, offset + cellText.length)
                    starts.push(range.getBoundingClientRect().left)
                    offset += cellText.length
                  }
                }
                const bounds = preedit.getBoundingClientRect()
                const caret = screen.querySelector<HTMLElement>('.xterm-composition-caret')!
                return {
                  dpr: devicePixelRatio,
                  webgl: Boolean(screen.querySelector('canvas')),
                  cellWidth,
                  committed,
                  starts: starts.map((left) => left - bounds.left),
                  width: bounds.width,
                  expectedWidth: columns * cellWidth,
                  caretRight: caret.getBoundingClientRect().right - bounds.left,
                  textareaWidth: terminal.textarea!.getBoundingClientRect().width,
                  underlines: Array.from(
                    preedit.children,
                    (cell) => getComputedStyle(cell).textDecorationLine
                  )
                }
              })

              expect(sample.dpr).toBe(dpr)
              expect(sample.webgl).toBe(gpu === 'on')
              // Inline runs and their container round to Chromium's 1/64px layout units.
              const tolerance = Math.max(0.05, (sample.underlines.length + 1) / 64)
              for (const width of [sample.width, sample.caretRight, sample.textareaWidth]) {
                expect(Math.abs(width - sample.expectedWidth)).toBeLessThan(tolerance)
              }
              expect(sample.underlines.length).toBeLessThanOrEqual(sample.committed.length)
              expect(
                sample.underlines.every((decoration) => decoration.includes('underline'))
              ).toBe(true)
              for (const [index, cell] of sample.committed.entries()) {
                expect(
                  Math.abs(sample.starts[index] - cell.column * sample.cellWidth)
                ).toBeLessThan(tolerance)
              }
              if (options.fontSize === 13 && options.letterSpacing === 0 && text.startsWith('あ')) {
                await testInfo.attach('preedit-cell-grid', {
                  body: await orcaPage.screenshot(),
                  contentType: 'image/png'
                })
              }
              await setImeComposition(arena.session, '')
            }
          }
          await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H\x1b[999G')
          await setImeComposition(arena.session, 'あ'.repeat(8))
          await expect(orcaPage.locator('.xterm-composition-preedit')).toHaveText(
            `‎${'あ'.repeat(8)}‎`
          )
          const edge = await sampleMidlinePreeditOcclusion(orcaPage)
          const screenRight = edge.screenRect.left + edge.screenRect.width
          expect(edge.cursorColumn).toBe(edge.terminalColumns - 1)
          expect(Math.abs(edge.caretRect!.right - screenRight)).toBeLessThan(1 / dpr)
          expect(edge.caretRect!.left).toBeGreaterThanOrEqual(edge.screenRect.left)
          expect(Math.abs(edge.textareaRect.right - screenRight)).toBeLessThan(1 / dpr)

          await orcaPage.evaluate(() => {
            const state = window.__store!.getState()
            const terminal = window
              .__paneManagers!.get(state.activeTabId!)!
              .getActivePane()!.terminal
            terminal.options.fontSize = 16
          })
          await expect
            .poll(async () => (await sampleMidlinePreeditOcclusion(orcaPage)).cellWidth)
            .not.toBe(edge.cellWidth)
          await expect
            .poll(() =>
              orcaPage.evaluate(() => {
                const state = window.__store!.getState()
                const terminal = window
                  .__paneManagers!.get(state.activeTabId!)!
                  .getActivePane()!.terminal
                const cellWidth = (terminal as unknown as TerminalGrid)._core._renderService
                  .dimensions.css.cell.width
                const preedit = terminal.element!.querySelector('.xterm-composition-preedit')!
                return Math.abs(preedit.getBoundingClientRect().width - 16 * cellWidth)
              })
            )
            .toBeLessThan(0.05)
          await setImeComposition(arena.session, '')
          completed = true
        } finally {
          await closeTerminalImePaneArena(arena, testInfo, 'preedit-cell-grid', !completed)
        }
      })
    })
  }
}

test('preserves native shaping for mixed text, complex scripts, and emoji', async ({
  orcaPage
}, testInfo) => {
  const arena = await openTerminalImePaneArena(orcaPage)
  let completed = false
  try {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const terminal = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal
      terminal.options.fontFamily = 'FiraCode Nerd Font, monospace'
      terminal.options.fontSize = 26
    })
    for (const text of [
      'سلام',
      'क्षि',
      '👩‍💻',
      '🇯🇵',
      'a\u00adb',
      'ᄀ가',
      '가〮',
      '=>',
      'l·l',
      'か\u3099',
      'ｶﾞ',
      '㊗️',
      'ffi',
      'abc  XYZ',
      '\u3099a'
    ]) {
      await writeToActiveTerminal(orcaPage, '\x1b[2J\x1b[H')
      await setImeComposition(arena.session, text)
      const preedit = orcaPage.locator('.composition-view.active .xterm-composition-preedit')
      await expect(preedit).toHaveText(`‎${text}‎`)
      const actual = await preedit.screenshot()

      // Compare against the original single-text-node browser rendering.
      await preedit.evaluate((element, text) => {
        const span = element as HTMLElement
        span.textContent = `‎${text}‎`
        for (const property of ['width', 'white-space', 'display', 'position']) {
          span.style.removeProperty(property)
        }
      }, text)
      expect(actual, `native shaping of ${text}`).toEqual(await preedit.screenshot())
      await setImeComposition(arena.session, '')
    }
    completed = true
  } finally {
    await closeTerminalImePaneArena(arena, testInfo, 'preedit-native-shaping', !completed)
  }
})
