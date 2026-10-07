import type { Page, TestInfo } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect } from './orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './terminal'
import { enableInlineImages } from './terminal-inline-image-proof'
import { prepareInlineImageRuntime } from './terminal-inline-image-runtime'
import { nodeTerminalCommand } from '../terminal-node-command'

function layeredImagePayload(z: number, alpha = 255): string {
  const png = new PNG({ width: 120, height: 120 })
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([240, 40, 40, alpha], offset)
  }
  const source = PNG.sync.write(png).toString('base64')
  let payload = '\x1bc'
  for (const [index, background] of ['', '\x1b[48;2;40;240;40m'].entries()) {
    const top = index === 0 ? 3 : 9
    for (let row = top; row < top + 4; row++) {
      payload += `\x1b[${row};3H\x1b[38;2;40;40;240m${background}MMMMMMMM\x1b[0m`
    }
    const id = index + 1
    payload += `\x1b_Ga=t,f=100,i=${id},q=2;${source}\x1b\\`
    // Exercise the application's transmit/delete/place redraw sequence.
    for (let frame = 0; frame < 3; frame++) {
      payload += `\x1b_Ga=d,d=i,i=${id},q=2;\x1b\\\x1b[${top};3H\x1b_Ga=p,i=${id},p=1,c=8,r=4,C=1,z=${z},q=2;\x1b\\`
    }
  }
  return `${payload}\x1b[16;1HIMAGE_LAYER_PROOF_DONE\r\n`
}

export async function prepareLayerImage(
  orcaPage: Page,
  testInfo: TestInfo,
  acceleration: 'off' | 'on',
  z: number,
  alpha: number,
  hold = false,
  runtime: 'native' | 'wsl' = 'native'
): Promise<string> {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(async (policy) => {
    await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
  }, acceleration)
  await prepareInlineImageRuntime(orcaPage, runtime)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await enableInlineImages(orcaPage)
  await orcaPage.evaluate(() => {
    const tab = window.__store!.getState().activeTabId
    const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
    if (!terminal) {
      throw new Error('Missing layer proof terminal')
    }
    terminal.options.theme = { ...terminal.options.theme, background: '#ffffff' }
  })
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
  const producer = testInfo.outputPath('image-layers.cjs')
  const payload = Buffer.from(layeredImagePayload(z, alpha) + (hold ? '\x1b[3;3H' : '')).toString(
    'base64'
  )
  writeFileSync(
    producer,
    `process.stdout.write(Buffer.from('${payload}', 'base64'));${hold ? 'setInterval(() => {}, 10000)' : ''}`
  )
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await execInTerminal(
    orcaPage,
    ptyId,
    runtime === 'wsl'
      ? `printf '%s' '${payload}' | base64 -d${hold ? '; sleep 3600' : ''}`
      : nodeTerminalCommand([producer])
  )
  await waitForTerminalOutput(orcaPage, 'IMAGE_LAYER_PROOF_DONE', 30_000)
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  return ptyId
}

export async function assertLayerImagePixels(
  orcaPage: Page,
  path: string,
  z: number,
  alpha: number,
  tops: readonly number[] = [2, 8]
): Promise<void> {
  const rows = await orcaPage.evaluate(() => {
    const tab = window.__store!.getState().activeTabId
    const pane = tab && window.__paneManagers?.get(tab)?.getActivePane()
    if (!pane) {
      throw new Error('Missing layer proof terminal')
    }
    return { rows: pane.terminal.rows, cols: pane.terminal.cols }
  })
  const screen = orcaPage.locator('.pane:visible .xterm-screen').first()
  const pixels = PNG.sync.read(await screen.screenshot({ path: path }))
  for (const [index, top] of tops.entries()) {
    const counts = { red: 0, green: 0, blue: 0, blended: 0, white: 0 }
    const blended = index === 0 ? [247, 147, 147] : [140, 140, 40]
    // Screenshots round fractional CSS bounds outward; sample inside the placement.
    for (
      let y = Math.max(0, Math.ceil((top * pixels.height) / rows.rows)) + 1;
      y < Math.min(pixels.height, Math.floor(((top + 4) * pixels.height) / rows.rows)) - 1;
      y++
    ) {
      for (
        let x = Math.ceil((2 * pixels.width) / rows.cols) + 1;
        x < Math.floor((10 * pixels.width) / rows.cols) - 1;
        x++
      ) {
        const offset = (y * pixels.width + x) * 4
        const [r, g, b] = pixels.data.subarray(offset, offset + 3)
        if (r > 220 && g < 60 && b < 60) {
          counts.red++
        }
        if (g > 220 && r < 60 && b < 60) {
          counts.green++
        }
        if (b > 220 && r < 60 && g < 60) {
          counts.blue++
        }
        if (r > 220 && g > 220 && b > 220) {
          counts.white++
        }
        if (
          Math.abs(r - blended[0]) < 4 &&
          Math.abs(g - blended[1]) < 4 &&
          Math.abs(b - blended[2]) < 4
        ) {
          counts.blended++
        }
      }
    }
    const behindBackground = index === 1 && z < -1073741824
    expect(
      (alpha === 255 ? counts.red : counts.blended) > 1000,
      `image visibility at row ${top}, z=${z}, alpha=${alpha}`
    ).toBe(!behindBackground)
    expect(counts.blue > 20, `text visibility at row ${top}, z=${z}`).toBe(z < 0)
    expect(counts.green > 1000, `explicit background visibility at row ${top}, z=${z}`).toBe(
      behindBackground
    )
    expect(
      counts.white,
      `glyph edges must composite against the image or cell background: ${JSON.stringify({ top, rows, width: pixels.width, height: pixels.height })}`
    ).toBeLessThan(10)
  }
}
