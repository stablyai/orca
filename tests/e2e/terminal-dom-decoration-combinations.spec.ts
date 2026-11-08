import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureActiveWorktreePaneLoad,
  waitForTerminalOutputForPtyId
} from './artificial-opencode-pane-interactions'

test('DOM terminal combines independent decoration lines without flattening underline styles', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const [pane] = await ensureActiveWorktreePaneLoad(orcaPage, 1)
  const script = await runNodeScriptInTerminal(
    orcaPage,
    pane.ptyId,
    "process.stdin.resume()\nconsole.log('DECORATIONS_READY')\n"
  )
  registerPostElectronShutdownCleanup(async () => script.cleanup())
  await waitForTerminalOutputForPtyId(orcaPage, pane.ptyId, 'DECORATIONS_READY', 15_000)

  const cases = [
    { name: 'overline-strike', sgr: '53;9', bands: 2 },
    { name: 'solid-all', sgr: '4;53;9', bands: 3 },
    { name: 'double-all', sgr: '4:2;53;9', bands: 4 },
    { name: 'dotted-all', sgr: '4:4;53;9', bands: 3 }
  ]
  const clips = await orcaPage.evaluate(
    async ({ paneKey, cases }) => {
      const [tabId, leafId] = paneKey.split(':')
      const manager = window.__paneManagers!.get(tabId)!
      manager.setTerminalGpuAcceleration('off')
      const terminal = manager.getPanes().find((pane) => pane.leafId === leafId)!.terminal
      terminal.options = {
        fontFamily: 'monospace',
        fontSize: 20,
        lineHeight: 1.4,
        minimumContrastRatio: 1,
        theme: { background: '#202020', foreground: '#ff5050' }
      }
      const lines = cases.map(({ sgr }) => `\x1b[${sgr}m${'\u00a0'.repeat(8)}\x1b[0m`)
      await new Promise<void>((resolve) =>
        terminal.write(`\x1b[?25l\x1b[2J\x1b[H\r\n\r\n${lines.join('\r\n\r\n\r\n\r\n')}`, resolve)
      )
      await new Promise<void>((resolve) => {
        const listener = terminal.onRender(() => {
          listener.dispose()
          resolve()
        })
        terminal.refresh(0, terminal.rows - 1)
      })
      const rows = terminal.element!.querySelector('.xterm-rows')!
      return cases.map((_, index) => {
        const rect = rows.children[index * 4 + 2].firstElementChild!.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y - rect.height,
          width: rect.width,
          height: rect.height * 3
        }
      })
    },
    { paneKey: pane.paneKey, cases }
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('decorations.png') })

  for (const [index, entry] of cases.entries()) {
    const image = PNG.sync.read(
      await orcaPage.screenshot({
        clip: clips[index],
        path: testInfo.outputPath(`${entry.name}.png`)
      })
    )
    const bands: number[] = []
    let inBand = false
    for (let y = 0; y < image.height; y++) {
      let redPixels = 0
      for (let x = 0; x < image.width; x++) {
        const offset = (y * image.width + x) * 4
        const [red, green, blue] = image.data.subarray(offset, offset + 3)
        if (red > green + 40 && red > blue + 40) {
          redPixels++
        }
      }
      if (redPixels > 0) {
        if (!inBand) {
          bands.push(0)
        }
        bands[bands.length - 1] = Math.max(bands.at(-1)!, redPixels / image.width)
      }
      inBand = redPixels > 0
    }
    expect(bands, entry.name).toHaveLength(entry.bands)
    expect(bands[0], `${entry.name} solid overline`).toBeGreaterThan(0.8)
    expect(bands[1], `${entry.name} solid strike`).toBeGreaterThan(0.8)
    if (entry.name === 'dotted-all') {
      expect(bands[2], 'dotted underline has gaps').toBeGreaterThan(0.1)
      expect(bands[2], 'dotted underline has gaps').toBeLessThan(0.8)
    }
  }
})
