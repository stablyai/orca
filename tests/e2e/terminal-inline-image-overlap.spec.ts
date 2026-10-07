import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { prepareLayerImage } from './helpers/terminal-inline-image-layers'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'

function image(color: readonly number[]): string {
  const png = new PNG({ width: 120, height: 120 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set(color, i)
  }
  return PNG.sync.write(png).toString('base64')
}

for (const acceleration of ['off', 'on'] as const) {
  for (const [virtualId, physicalId] of [
    [9, 2],
    [2, 9]
  ] as const) {
    test(`${acceleration}: overlapping placeholder ${virtualId} and physical ${physicalId} follow equal-z image ID order`, async ({
      orcaPage
    }, testInfo) => {
      const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 255)
      const rows = ['\u0305', '\u030D', '\u030E', '\u0310']
      const placeholders = rows
        .map((row, index) => `\x1b[${index + 3};3H\u{10EEEE}${row}\u0305${'\u{10EEEE}'.repeat(7)}`)
        .join('')
      const payload =
        `\x1bc\x1b_Ga=T,f=100,i=${virtualId},U=1,c=8,r=4,q=2;${image([240, 40, 40, 255])}\x1b\\` +
        `\x1b[38;2;0;0;${virtualId}m${placeholders}\x1b[0m\x1b[3;3H` +
        `\x1b_Ga=T,f=100,i=${physicalId},C=1,z=0,c=8,r=4,q=2;${image([40, 40, 240, 255])}\x1b\\` +
        '\x1b[16;1HOVERLAP_IMAGE_DONE\r\n'
      const producer = testInfo.outputPath('image-overlap.cjs')
      writeFileSync(
        producer,
        `process.stdout.write(Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64'))`
      )
      await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer]))
      await waitForTerminalOutput(orcaPage, 'OVERLAP_IMAGE_DONE', 30_000)
      const dimensions = await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
        if (!terminal) {
          throw new Error('Missing overlap terminal')
        }
        return { cols: terminal.cols, rows: terminal.rows }
      })
      await expect
        .poll(async () => {
          const png = PNG.sync.read(
            await orcaPage
              .locator('.pane:visible .xterm-screen')
              .first()
              .screenshot({ path: testInfo.outputPath('overlap.png') })
          )
          let red = 0
          let blue = 0
          for (
            let y = Math.ceil((2 * png.height) / dimensions.rows);
            y < (6 * png.height) / dimensions.rows;
            y++
          ) {
            for (
              let x = Math.ceil((4 * png.width) / dimensions.cols);
              x < (8 * png.width) / dimensions.cols;
              x++
            ) {
              const i = (y * png.width + x) * 4
              if (png.data[i] > 220 && png.data[i + 1] < 60 && png.data[i + 2] < 60) {
                red++
              }
              if (png.data[i + 2] > 220 && png.data[i] < 60 && png.data[i + 1] < 60) {
                blue++
              }
            }
          }
          return virtualId > physicalId ? red > 1000 && blue < 10 : blue > 1000 && red < 10
        })
        .toBe(true)
    })
  }
}
