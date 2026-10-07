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
        const cell = terminal.dimensions?.css.cell
        if (!cell || cell.width <= 0 || cell.height <= 0) {
          throw new Error('Missing decoration proof cell metrics')
        }
        return {
          cellWidth: cell.width,
          cellHeight: cell.height,
          row: marker.line - terminal.buffer.active.viewportY
        }
      })
      await expect
        .poll(async () => {
          const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
          const bounds = await screen.boundingBox()
          if (!bounds) {
            throw new Error('Missing decoration proof screen bounds')
          }
          const png = PNG.sync.read(
            await screen.screenshot({ path: testInfo.outputPath('top-decoration.png') })
          )
          const counts = { green: 0, blue: 0, red: 0, samples: 0 }
          const cw = (dimensions.cellWidth * png.width) / bounds.width
          const ch = (dimensions.cellHeight * png.height) / bounds.height
          for (
            let y = Math.ceil(dimensions.row * ch) + 1;
            y < Math.floor((dimensions.row + 1) * ch) - 1;
            y++
          ) {
            for (let x = Math.ceil(4 * cw) + 1; x < Math.floor(8 * cw) - 1; x++) {
              const i = (y * png.width + x) * 4
              counts.samples++
              if (png.data[i] < 60 && png.data[i + 1] > 220 && png.data[i + 2] < 60) {
                counts.green++
              }
              if (png.data[i] < 60 && png.data[i + 1] < 60 && png.data[i + 2] > 220) {
                counts.blue++
              }
              if (png.data[i] > 220 && png.data[i + 1] < 60 && png.data[i + 2] < 60) {
                counts.red++
              }
            }
          }
          return {
            ...counts,
            backgroundVisible: counts.green > counts.samples / 4,
            glyphsVisible: counts.blue > 5,
            imageCovered: counts.red < counts.samples / 50,
            rowSampled: counts.samples > 2 * cw * ch
          }
        })
        .toMatchObject({
          backgroundVisible: true,
          glyphsVisible: true,
          imageCovered: true,
          rowSampled: true
        })
    } finally {
      await sendToTerminal(orcaPage, pty, '\x03').catch(() => undefined)
    }
  })
}
