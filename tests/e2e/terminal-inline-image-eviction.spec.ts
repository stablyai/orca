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
import { enableInlineImages, readInlineImageState } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

function upload(id: number, color: readonly number[]): string {
  const png = new PNG({ width: 1200, height: 1200 })
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([...color, 255], offset)
  }
  return `\x1b_Ga=T,f=100,i=${id},U=1,c=8,r=4,q=2;${PNG.sync.write(png).toString('base64')}\x1b\\`
}

function cells(id: number): string {
  const rows = ['\u0305', '\u030D', '\u030E', '\u0310']
  const grid = rows.map((row) => `\u{10EEEE}${row}${'\u{10EEEE}'.repeat(7)}`).join('\r\n')
  return `\x1b[6;5H\x1b[38;2;0;0;${id}m${grid}\x1b[0m`
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: visible images survive offscreen cache pressure and evicted sources can be placed again`, async ({
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
          const tab = window.__store!.getState().activeTabId
          const manager = tab && window.__paneManagers?.get(tab)
          const pane = manager && manager.getActivePane()
          return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
        })
      )
      .toBe(acceleration === 'on')
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const producer = testInfo.outputPath('image-cache-pressure.cjs')
    const offscreen = Array.from({ length: 5 }, (_, index) =>
      upload(index + 8, [240, 160, 40])
    ).join('')
    const initial = `\x1bc${upload(7, [240, 40, 40])}${cells(7)}${offscreen}\x1b[15;1HCACHE_PRESSURE_DONE\r\n`
    writeFileSync(
      producer,
      `process.stdout.write(Buffer.from('${Buffer.from(initial).toString('base64')}', 'base64'))`
    )
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
    await waitForTerminalOutput(orcaPage, 'CACHE_PRESSURE_DONE', 30_000)
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
    const assertPixels = async (orange: boolean, filename: string) => {
      await expect
        .poll(
          async () => {
            const png = PNG.sync.read(
              await screen.screenshot({ path: testInfo.outputPath(filename) })
            )
            let pixels = 0
            for (let offset = 0; offset < png.data.length; offset += 4) {
              const [r, g, b] = png.data.subarray(offset, offset + 3)
              if (r > 220 && b < 60 && (orange ? g > 140 && g < 180 : g < 60)) {
                pixels++
              }
            }
            return pixels
          },
          { timeout: 10_000, message: 'The visible image must remain painted under cache pressure' }
        )
        .toBeGreaterThan(1000)
    }
    await assertPixels(false, 'cache-visible-image.png')
    expect((await readInlineImageState(orcaPage))?.storageMB).toBeLessThanOrEqual(32)
    expect((await readInlineImageState(orcaPage))?.images).toBe(5)

    const restore = testInfo.outputPath('image-cache-restore.cjs')
    const bytes = `\x1b_Ga=p,U=1,i=8,c=8,r=4,q=2;\x1b\\${cells(8)}\x1b[15;1HCACHE_RESTORE_DONE\r\n`
    writeFileSync(
      restore,
      `process.stdout.write(Buffer.from('${Buffer.from(bytes).toString('base64')}', 'base64'))`
    )
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([restore]))
    await waitForTerminalOutput(orcaPage, 'CACHE_RESTORE_DONE', 30_000)
    await assertPixels(true, 'cache-restored-image.png')
    expect((await readInlineImageState(orcaPage))?.storageMB).toBeLessThanOrEqual(32)
  })
}
