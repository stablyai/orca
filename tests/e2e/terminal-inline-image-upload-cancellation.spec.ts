import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { prepareLayerImage } from './helpers/terminal-inline-image-layers'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

function image(color: readonly number[]): string {
  const pixels = new PNG({ width: 80, height: 48 })
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    pixels.data.set(color, offset)
  }
  return PNG.sync.write(pixels).toString('base64')
}

const red = image([255, 0, 0, 255])
const green = image([0, 255, 0, 255])
const osc = (payload: string) => `\x1b]1337;${payload}\x07`
const header = 'MultipartFile=inline=1;width=80px;height=48px;preserveAspectRatio=0'

for (const acceleration of ['off', 'on'] as const) {
  for (const failure of ['CAN', 'SUB', 'Base64 failure'] as const) {
    test(`${acceleration}: ${failure} drops the upload and permits the next image`, async ({
      orcaPage
    }, testInfo) => {
      const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 255)
      const marker = `IMAGE_UPLOAD_RECOVERED_${failure.replaceAll(' ', '_')}`
      const invalid =
        failure === 'Base64 failure'
          ? `${'!'.repeat(131072)}\x07`
          : `${red.slice(4, 8)}${failure === 'CAN' ? '\x18' : '\x1a'}`
      const payload = `\x1bc\x1b[?25l\x1b[3;3H${osc(header)}${osc(`FilePart=${red.slice(0, 4)}`)}\x1b]1337;FilePart=${invalid}${osc(`FilePart=${red.slice(8)}`)}${osc('FileEnd')}\x1b[9;3H${osc(header)}${osc(`FilePart=${green}`)}${osc('FileEnd')}\x1b[16;1H${marker}\r\n`
      const producer = testInfo.outputPath('image-upload-cancellation.cjs')
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
      const dimensions = await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        const pane = tab && window.__paneManagers?.get(tab)?.getActivePane()
        if (!pane) {
          throw new Error('Missing image upload terminal')
        }
        return { cols: pane.terminal.cols, rows: pane.terminal.rows }
      })
      const pixels = PNG.sync.read(
        await orcaPage
          .locator('.pane:visible .xterm-screen')
          .first()
          .screenshot({
            path: testInfo.outputPath('image-upload-recovery.png')
          })
      )
      const counts = { canceledRed: 0, recoveredGreen: 0 }
      for (let y = 0; y < pixels.height; y++) {
        for (let x = 0; x < pixels.width; x++) {
          const offset = (y * pixels.width + x) * 4
          const [r, g, b] = pixels.data.subarray(offset, offset + 3)
          const column = (x * dimensions.cols) / pixels.width
          const row = (y * dimensions.rows) / pixels.height
          if (column < 2 || column > 16) {
            continue
          }
          if (row >= 2 && row < 6 && r > 240 && g < 15 && b < 15) {
            counts.canceledRed++
          }
          if (row >= 8 && row < 12 && g > 240 && r < 15 && b < 15) {
            counts.recoveredGreen++
          }
        }
      }
      expect(counts.canceledRed, 'Canceled image must not appear').toBe(0)
      expect(counts.recoveredGreen, 'Next multipart image must render').toBeGreaterThan(1000)
    })
  }
}
