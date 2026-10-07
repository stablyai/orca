import { expect, test } from './helpers/orca-app'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

for (const acceleration of ['off', 'on'] as const) {
  for (const z of [-1, -1499999999]) {
    test(`${acceleration}: negative z=${z} retains composition through scroll, clipping, zoom and resize`, async ({
      orcaPage
    }, testInfo) => {
      const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, z, 255)
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('initial.png'), z, 255)
      await execInTerminal(
        orcaPage,
        pty,
        nodeTerminalCommand([
          '-e',
          "process.stdout.write('\\r\\n'.repeat(100)); console.log('NEGATIVE_SCROLL_' + 'DONE')"
        ])
      )
      await waitForTerminalOutput(orcaPage, 'NEGATIVE_SCROLL_DONE', 30_000)

      const showImageRows = async (clipRows = 0) => {
        await orcaPage.evaluate((clip) => {
          const tab = window.__store!.getState().activeTabId
          const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
          if (!terminal) {
            throw new Error('Missing negative-image terminal')
          }
          for (let row = 0; row < terminal.buffer.active.length; row++) {
            if (terminal.buffer.active.getLine(row)?.translateToString().includes('MMMMMMMM')) {
              terminal.scrollToLine(row + clip)
              return
            }
          }
          throw new Error('Image text disappeared from scrollback')
        }, clipRows)
        await orcaPage.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
      }
      await showImageRows()
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('scrollback.png'), z, 255, [0, 6])
      await showImageRows(1)
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('clipped.png'), z, 255, [-1, 5])
      await orcaPage.evaluate(async () => {
        await window.__store!.getState().updateSettings({ terminalFontSize: 28 })
      })
      const waitForFittedGrid = async () => {
        await expect
          .poll(() =>
            orcaPage.evaluate(() => {
              const tab = window.__store!.getState().activeTabId
              const pane = tab && window.__paneManagers?.get(tab)?.getActivePane()
              const proposed = pane && pane.fitAddon.proposeDimensions()
              return Boolean(
                pane &&
                proposed &&
                pane.terminal.options.fontSize === 28 &&
                pane.terminal.cols === proposed.cols &&
                pane.terminal.rows === proposed.rows
              )
            })
          )
          .toBe(true)
      }
      await waitForFittedGrid()
      await showImageRows()
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('zoom.png'), z, 255, [0, 6])
      await orcaPage.setViewportSize({ width: 1000, height: 800 })
      await waitForFittedGrid()
      await showImageRows()
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('resize.png'), z, 255, [0, 6])
      expect(await waitForActivePanePtyId(orcaPage)).toBe(pty)
    })
  }
}
