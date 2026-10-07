import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { prepareLayerImage } from './helpers/terminal-inline-image-layers'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

const rgba = Array.from({ length: 64 }, (_, i) => [
  i % 2 ? 255 : 0,
  i % 3 ? 0 : 255,
  i % 5 ? 0 : 255,
  [0, 64, 128, 255][i % 4]
]).flat()
const png = new PNG({ width: 8, height: 8 })
png.data.set(rgba)
const formats = {
  png: PNG.sync.write(png).toString('base64'),
  qoi: Buffer.from([
    ...Buffer.from('qoif'),
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    8,
    4,
    0,
    ...Array.from({ length: 64 }, (_, i) => [255, ...rgba.slice(i * 4, i * 4 + 4)]).flat(),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1
  ]).toString('base64')
}

const red = new PNG({ width: 8, height: 8 })
for (let i = 0; i < red.data.length; i += 4) {
  red.data.set([255, 0, 0, 255], i)
}
const compactFormats = {
  png: PNG.sync.write(red).toString('base64'),
  qoi: Buffer.from('716f696600000008000000080400ffff0000fffdc00000000000000001', 'hex').toString(
    'base64'
  )
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: QOI resizing matches PNG through the PTY`, async ({
    orcaPage
  }, testInfo) => {
    const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 255)
    const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
    const dimensions = await orcaPage.evaluate(() => {
      const tab = window.__store!.getState().activeTabId
      const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
      if (!terminal) {
        throw new Error('Missing QOI terminal')
      }
      return { cols: terminal.cols, rows: terminal.rows }
    })
    const bounds = await screen.boundingBox()
    if (!bounds) {
      throw new Error('Missing terminal screen bounds')
    }

    for (const [width, height, sources] of [
      [3, 3, formats],
      [13, 11, formats],
      [1, 1, formats],
      [130, 110, formats],
      [8, 8, compactFormats]
    ] as const) {
      const captures: PNG[] = []
      for (const [format, bytes] of Object.entries(sources)) {
        const marker = `QOI_RASTER_${format}_${width}_${height}`
        const payload = `\x1bc\x1b[3;3H\x1b]1337;File=inline=1;width=${width}px;height=${height}px;preserveAspectRatio=0:${bytes}\x07\x1b[16;1H${marker}\r\n`
        const producer = testInfo.outputPath(`${marker}.cjs`)
        writeFileSync(
          producer,
          `process.stdout.write(Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64'))`
        )
        await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer]))
        await waitForTerminalOutput(orcaPage, marker, 30_000)
        await orcaPage.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        captures.push(
          PNG.sync.read(
            await screen.screenshot({
              path: testInfo.outputPath(`${marker}.png`)
            })
          )
        )
      }
      const [expected, actual] = captures
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height])
      const scale = expected.width / bounds.width
      const left = Math.floor((2 * expected.width) / dimensions.cols)
      const top = Math.floor((2 * expected.height) / dimensions.rows)
      const right = Math.ceil((2 * expected.width) / dimensions.cols + width * scale)
      const bottom = Math.ceil((2 * expected.height) / dimensions.rows + height * scale)
      let maxDelta = 0
      let colored = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * expected.width + x) * 4
          for (let channel = 0; channel < 3; channel++) {
            maxDelta = Math.max(
              maxDelta,
              Math.abs(expected.data[offset + channel] - actual.data[offset + channel])
            )
            if (expected.data[offset + channel] < 240) {
              colored++
            }
          }
        }
      }
      expect(colored, `${width}x${height} PNG control must render`).toBeGreaterThan(0)
      expect(maxDelta, `${width}x${height} QOI/PNG channel difference`).toBeLessThanOrEqual(4)
    }
  })
}
