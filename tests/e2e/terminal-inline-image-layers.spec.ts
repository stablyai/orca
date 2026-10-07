import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { sendToTerminal } from './helpers/terminal'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'

for (const acceleration of ['off', 'on'] as const) {
  for (const [z, alpha] of [
    [0, 255],
    [-1, 255],
    [-1499999999, 255],
    [0, 128],
    [-1, 128],
    [-1499999999, 128]
  ] as const) {
    test(`${acceleration}: Kitty z=${z}, alpha=${alpha} composes with text and explicit backgrounds`, async ({
      orcaPage
    }, testInfo) => {
      await prepareLayerImage(orcaPage, testInfo, acceleration, z, alpha)
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('image-layers.png'), z, alpha)
    })
  }
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: selection and inactive block cursor remain above negative images`, async ({
    orcaPage
  }, testInfo) => {
    const ptyId = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 255, true)
    try {
      const dimensions = await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
        if (!terminal) {
          throw new Error('Missing overlay proof terminal')
        }
        terminal.options.theme = {
          ...terminal.options.theme,
          selectionBackground: '#28f0f0',
          selectionInactiveBackground: '#28f0f0',
          cursor: '#f028f0'
        }
        terminal.options.cursorBlink = false
        terminal.options.cursorInactiveStyle = 'block'
        terminal.select(2, 2, 8)
        return { cols: terminal.cols, rows: terminal.rows }
      })
      await orcaPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
      const png = PNG.sync.read(
        await screen.screenshot({ path: testInfo.outputPath('overlays.png') })
      )
      const cellWidth = png.width / dimensions.cols
      const cellHeight = png.height / dimensions.rows
      const counts = { selection: 0, cursor: 0 }
      for (let y = Math.ceil(2 * cellHeight); y < 3 * cellHeight; y++) {
        for (let x = Math.ceil(2 * cellWidth); x < 10 * cellWidth; x++) {
          const offset = (y * png.width + x) * 4
          const [r, g, b] = png.data.subarray(offset, offset + 3)
          if (r < 60 && g > 220 && b > 220) {
            counts.selection++
          }
          if (r > 220 && g < 60 && b > 220) {
            counts.cursor++
          }
        }
      }
      await testInfo.attach('overlay-pixel-counts', {
        body: JSON.stringify(counts),
        contentType: 'application/json'
      })
      expect(
        counts.selection,
        'selection background remains visible over the image'
      ).toBeGreaterThan(2 * cellWidth * cellHeight)
      expect(counts.cursor, 'block cursor remains visible over the image').toBeGreaterThan(
        (cellWidth * cellHeight) / 4
      )
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: top decoration backgrounds remain above negative images`, async ({
    orcaPage
  }, testInfo) => {
    const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 255, true)
    try {
      const dimensions = await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
        const marker = terminal && terminal.registerMarker(2)
        if (!terminal || !marker) {
          throw new Error('Missing decoration proof marker')
        }
        const decoration = terminal.registerDecoration({
          marker,
          x: 4,
          width: 4,
          backgroundColor: '#28f028',
          layer: 'top'
        })
        if (!decoration) {
          throw new Error('Missing decoration proof handle')
        }
        return { cols: terminal.cols, rows: terminal.rows }
      })
      await expect
        .poll(async () => {
          const png = PNG.sync.read(
            await orcaPage
              .locator('.pane:visible .xterm-screen')
              .first()
              .screenshot({
                path: testInfo.outputPath('top-decoration.png')
              })
          )
          let green = 0
          const cw = png.width / dimensions.cols
          const ch = png.height / dimensions.rows
          for (let y = Math.ceil(4 * ch); y < Math.floor(5 * ch); y++) {
            for (let x = Math.ceil(4 * cw); x < Math.floor(8 * cw); x++) {
              const i = (y * png.width + x) * 4
              if (png.data[i] < 60 && png.data[i + 1] > 220 && png.data[i + 2] < 60) {
                green++
              }
            }
          }
          return green / (cw * ch)
        })
        .toBeGreaterThan(2)
    } finally {
      await sendToTerminal(orcaPage, pty, '\x03').catch(() => undefined)
    }
  })
}
