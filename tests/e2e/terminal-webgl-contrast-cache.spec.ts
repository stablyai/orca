import type { Page } from '@stablyai/playwright-test'
import type { ITerminalOptions } from '@xterm/xterm'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureActiveWorktreePaneLoad,
  waitForTerminalOutputForPtyId
} from './artificial-opencode-pane-interactions'

async function preparePanes(
  page: Page,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const panes = await ensureActiveWorktreePaneLoad(page, 2)
  for (const pane of panes) {
    const script = await runNodeScriptInTerminal(
      page,
      pane.ptyId,
      "process.stdin.resume()\nconsole.log('CONTRAST_READY')\n"
    )
    registerCleanup(async () => script.cleanup())
    await waitForTerminalOutputForPtyId(page, pane.ptyId, 'CONTRAST_READY', 15_000)
  }
  await page.evaluate(() => {
    for (const manager of window.__paneManagers!.values()) {
      manager.setTerminalGpuAcceleration('on')
    }
  })
  await expect
    .poll(() =>
      page.evaluate(
        (keys) =>
          keys.every((key) => {
            const [tabId, leafId] = key.split(':')
            const manager = window.__paneManagers!.get(tabId)!
            const pane = manager.getPanes().find((pane) => pane.leafId === leafId)!
            return manager.hasWebglRenderer(pane.id)
          }),
        panes.map((pane) => pane.paneKey)
      )
    )
    .toBe(true)
  return panes.map((pane) => pane.paneKey)
}

async function paint(
  page: Page,
  paneKey: string,
  data: string,
  options: ITerminalOptions = {}
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(
    async ({ paneKey, data, options }) => {
      const [tabId, leafId] = paneKey.split(':')
      const terminal = window
        .__paneManagers!.get(tabId)!
        .getPanes()
        .find((pane) => pane.leafId === leafId)!.terminal
      terminal.options = options
      await new Promise<void>((resolve) => terminal.write(data, resolve))
      await new Promise<void>((resolve) => {
        const listener = terminal.onRender(() => {
          listener.dispose()
          resolve()
        })
        terminal.refresh(0, terminal.rows - 1)
      })
      const rect = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
      return { x: rect.x + 2, y: rect.y + 1, width: 180, height: 14 }
    },
    { paneKey, data, options }
  )
}

async function colors(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  path: string
): Promise<{ brightest: number; peakRedChroma: number }> {
  const image = PNG.sync.read(await page.screenshot({ clip, path }))
  let peakRed = 0
  let peakGreen = 0
  let peakBlue = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const [red, green, blue] = image.data.subarray(offset, offset + 3)
    peakRed = Math.max(peakRed, red)
    peakGreen = Math.max(peakGreen, green)
    peakBlue = Math.max(peakBlue, blue)
  }
  // Subpixel antialiasing can tint edge pixels; compare peak channel intensities.
  return {
    brightest: Math.max(peakRed, peakGreen, peakBlue),
    peakRedChroma: peakRed - Math.max(peakGreen, peakBlue)
  }
}

// The Linux headful project enables SwiftShader; its headless project disables WebGL.
test('@headful dim WebGL text follows a changed contrast ratio without changing another pane', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const [changed, neighbor] = await preparePanes(orcaPage, registerPostElectronShutdownCleanup)
  for (const key of [changed, neighbor]) {
    await paint(orcaPage, key, '\x1b[?25l\x1b[2J\x1b[H\x1b[2mDIM_PROBE\x1b[22m', {
      fontFamily: 'monospace',
      fontSize: 14,
      minimumContrastRatio: 3,
      theme: { background: '#000000', foreground: '#444444' }
    })
  }
  const changedClip = await paint(orcaPage, changed, '\x1b[H', {
    minimumContrastRatio: 21
  })
  expect(
    (await colors(orcaPage, changedClip, testInfo.outputPath('changed-ratio.png'))).brightest
  ).toBeGreaterThan(150)
  const neighborClip = await paint(orcaPage, neighbor, '\x1b[H')
  expect(
    (await colors(orcaPage, neighborClip, testInfo.outputPath('unchanged-ratio.png'))).brightest
  ).toBeLessThan(70)
})

test('@headful OSC palette changes keep WebGL contrast colors isolated between panes', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const [changed, neighbor] = await preparePanes(orcaPage, registerPostElectronShutdownCleanup)
  for (const key of [changed, neighbor]) {
    await paint(orcaPage, key, '\x1b[?25l\x1b[2J\x1b[H\x1b[31mPALETTE_PROBE\x1b[0m', {
      fontFamily: 'monospace',
      fontSize: 14,
      minimumContrastRatio: 4.5,
      theme: { background: '#000000', foreground: '#ffffff', red: '#444444' }
    })
  }
  const changedClip = await paint(orcaPage, changed, '\x1b]4;1;#ff0000\x07')
  expect(
    (await colors(orcaPage, changedClip, testInfo.outputPath('changed-palette.png'))).peakRedChroma
  ).toBeGreaterThan(150)
  // A non-ASCII glyph avoids the old atlas's ASCII warmup.
  const neighborClip = await paint(
    orcaPage,
    neighbor,
    `\r\x1b[2K\x1b[31m${'\u03a9'.repeat(8)}\x1b[0m`
  )
  const neighborColors = await colors(
    orcaPage,
    neighborClip,
    testInfo.outputPath('unchanged-palette.png')
  )
  expect(neighborColors.brightest).toBeGreaterThan(90)
  expect(neighborColors.brightest).toBeLessThan(150)
  expect(neighborColors.peakRedChroma).toBeLessThan(5)
})
