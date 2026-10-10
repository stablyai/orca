import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { enableInlineImages } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

const MARK = '\u{10EEEE}'
const ROWS = ['\u0305', '\u030D', '\u030E', '\u0310']

type ImageKind = 'cursor' | 'placeholder' | 'named' | 'letterbox' | 'transparent'

function imagePayload(kind: ImageKind): string {
  const virtual = kind !== 'cursor'
  const png = new PNG({ width: 120, height: kind === 'letterbox' ? 60 : 120 })
  for (let i = 0; i < png.data.length; i += 4) {
    const x = (i / 4) % png.width
    const y = Math.floor(i / 4 / png.width)
    const hole = kind === 'transparent' && x >= 30 && x < 90 && y >= 30 && y < 90
    png.data.set([240, 40, 40, hole ? 0 : 255], i)
  }
  const encoded = PNG.sync.write(png).toString('base64')
  const placement =
    kind === 'named'
      ? `\x1b_Ga=T,f=100,i=65280,p=11,c=1,r=1,q=2,U=1;${encoded}\x1b\\` +
        `\x1b_Ga=p,i=65280,p=10,c=8,r=4,q=2,U=1;\x1b\\`
      : `\x1b_Ga=T,f=100,i=65280,c=8,r=4,q=2${virtual ? ',U=1' : ''};${encoded}\x1b\\`
  const cells = ROWS.map((row) => `${MARK}${row}${'\u{10EEEE}'.repeat(7)}`).join('\r\n')
  return `\x1bc${placement}${
    virtual
      ? `\x1b[6;5H\x1b[38;2;0;255;0m${kind === 'named' ? '\x1b[58;2;0;0;10m' : ''}${cells}\x1b[0m`
      : ''
  }\x1b[12;5H\x1b[38;2;0;255;0mKEEP\x1b[0m\x1b[15;1HINLINE_RENDER_DONE\r\n`
}

for (const acceleration of ['off', 'on'] as const) {
  for (const kind of ['cursor', 'placeholder', 'named', 'letterbox', 'transparent'] as const) {
    test(`${acceleration}: Kitty ${kind} image paints at its intended cells`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(async (policy) => {
        await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
      }, acceleration)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await enableInlineImages(orcaPage)
      await expect
        .poll(() =>
          orcaPage.evaluate(() => {
            const tabId = window.__store!.getState().activeTabId
            const manager = tabId && window.__paneManagers?.get(tabId)
            const pane = manager && manager.getActivePane()
            return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
          })
        )
        .toBe(acceleration === 'on')
      const ptyId = await waitForActivePanePtyId(orcaPage)
      const producer = testInfo.outputPath('kitty-placeholder-producer.cjs')
      writeFileSync(
        producer,
        `process.stdout.write(Buffer.from('${Buffer.from(imagePayload(kind)).toString('base64')}', 'base64'))`
      )
      await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
      await waitForTerminalOutput(orcaPage, 'INLINE_RENDER_DONE', 30_000)
      const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
      await expect(screen).toBeVisible()
      const dimensions = await orcaPage.evaluate(() => {
        const tabId = window.__store!.getState().activeTabId
        const pane = tabId && window.__paneManagers?.get(tabId)?.getActivePane()
        if (!pane) {
          throw new Error('Missing image terminal')
        }
        return { cols: pane.terminal.cols, rows: pane.terminal.rows }
      })
      await expect
        .poll(
          async () => {
            const image = PNG.sync.read(
              await screen.screenshot({ path: testInfo.outputPath('kitty-cells.png') })
            )
            const cellWidth = image.width / dimensions.cols
            const cellHeight = image.height / dimensions.rows
            const col = kind === 'cursor' ? 0 : 4
            const row = kind === 'cursor' ? 0 : 5
            let redPixels = 0
            let greenPixels = 0
            for (let y = Math.ceil(row * cellHeight); y < (row + 4) * cellHeight; y++) {
              for (let x = Math.ceil(col * cellWidth); x < (col + 8) * cellWidth; x++) {
                const offset = (y * image.width + x) * 4
                if (
                  image.data[offset] > 220 &&
                  image.data[offset + 1] < 60 &&
                  image.data[offset + 2] < 60
                ) {
                  redPixels++
                }
                if (
                  image.data[offset] < 60 &&
                  image.data[offset + 1] > 220 &&
                  image.data[offset + 2] < 60
                ) {
                  greenPixels++
                }
              }
            }
            return { hasImage: redPixels > 1000, greenPixels }
          },
          { timeout: 15_000, message: 'Image pixels must appear in the addressed cell rectangle' }
        )
        .toEqual({ hasImage: true, greenPixels: 0 })
      const image = PNG.sync.read(await screen.screenshot())
      let redPixels = 0
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i] > 220 && image.data[i + 1] < 60 && image.data[i + 2] < 60) {
          redPixels++
        }
      }
      expect(redPixels).toBeGreaterThan(1000)
      if (kind === 'placeholder' || kind === 'named') {
        for (const action of ['delete', 'restore'] as const) {
          const operation =
            action === 'delete' ? 'a=d,d=i,i=65280,q=2' : 'a=p,U=1,i=65280,c=8,r=4,q=2'
          const command = operation + (kind === 'named' ? ',p=10' : '')
          const changeProducer = testInfo.outputPath(`kitty-${action}.cjs`)
          const bytes = Buffer.from(`\x1b_G${command};\x1b\\`).toString('base64')
          writeFileSync(changeProducer, `process.stdout.write(Buffer.from('${bytes}', 'base64'))`)
          await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([changeProducer]))
          await expect
            .poll(
              async () => {
                const png = PNG.sync.read(
                  await screen.screenshot({ path: testInfo.outputPath(`kitty-${action}.png`) })
                )
                let pixels = 0
                for (
                  let y = Math.ceil((5 * png.height) / dimensions.rows);
                  y < (9 * png.height) / dimensions.rows;
                  y++
                ) {
                  for (
                    let x = Math.ceil((4 * png.width) / dimensions.cols);
                    x < (12 * png.width) / dimensions.cols;
                    x++
                  ) {
                    const offset = (y * png.width + x) * 4
                    if (
                      png.data[offset] > 220 &&
                      png.data[offset + 1] < 60 &&
                      png.data[offset + 2] < 60
                    ) {
                      pixels++
                    }
                  }
                }
                return pixels > 1000
              },
              { timeout: 10_000, message: `${action} must repaint existing placeholder cells` }
            )
            .toBe(action === 'restore')
        }
      }
    })
  }
}
