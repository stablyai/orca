import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { ensureActiveWorktreePaneLoad } from './artificial-opencode-pane-interactions'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

function decorationPixels(screenshot: Buffer): {
  redBelow: number
  redMiddle: number
  blueBelow: number
  width: number
} {
  const image = PNG.sync.read(screenshot)
  let redBelow = 0
  let redMiddle = 0
  let blueBelow = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4
      const [red, green, blue] = image.data.subarray(offset, offset + 3)
      const isRed = red! > green! + 40 && red! > blue! + 40
      if (y >= image.height / 2) {
        if (isRed) {
          redBelow++
        }
        if (blue! > red! + 40 && blue! > green! + 20) {
          blueBelow++
        }
      }
      if (isRed && y >= image.height / 4 && y < (image.height * 3) / 4) {
        redMiddle++
      }
    }
  }
  return { redBelow, redMiddle, blueBelow, width: image.width }
}

test('DOM block fills preserve underline, strikeout and link-hover pixels', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  const [target] = await ensureActiveWorktreePaneLoad(orcaPage, 1)
  await waitForTerminalPtyDataInjector(orcaPage, target.paneKey)
  await orcaPage.evaluate(async ({ paneKey }) => {
    const [tabId, leafId] = paneKey.split(':')
    const manager = window.__paneManagers!.get(tabId)!
    manager.setTerminalGpuAcceleration('off')
    const terminal = manager.getPanes().find((pane) => pane.leafId === leafId)!.terminal
    terminal.options.cursorBlink = false
    terminal.options.minimumContrastRatio = 1
    terminal.options.theme = { background: '#202020', foreground: '#ffffff' }
    const lines = [
      '\x1b[38;2;255;80;80;4m\u2580\u2580\u2580\u2580\x1b[0m  Underline',
      '\x1b[38;2;255;80;80;9m\u2581\u2581\u2581\u2581\x1b[0m  Strikeout',
      '\x1b[38;2;255;80;80;4;58;2;100;150;255m\u2580\u2580\u2580\u2580\x1b[0m  Explicit underline',
      '\x1b[38;2;255;80;80m\u2580\u2580\u2580\u2580\x1b[0m  No decoration',
      '\x1b[38;2;255;80;80m\x1b]8;;https://example.test/blocks\x07\u2580\u2580\u2580\u2580\x1b]8;;\x07\x1b[0m  Link',
      'BLOCK_DECORATION_DONE'
    ]
    await new Promise<void>((resolve) =>
      terminal.write(
        `\x1b[?1049h\x1b[?25l\x1b[0m\x1b[2J\x1b[H\r\n${lines.join('\r\n\r\n\r\n')}\r\n`,
        resolve
      )
    )
  }, target)
  const rows = orcaPage.locator('.xterm-rows:visible')
  await expect(rows).toContainText('BLOCK_DECORATION_DONE')
  await orcaPage.mouse.move(1350, 700)
  const block = (index: number) =>
    rows
      .locator(':scope > div')
      .nth(index * 3 + 1)
      .locator('span')
      .first()
  const screenshot = async (index: number) => {
    const clip = await block(index).boundingBox()
    if (!clip) {
      throw new Error('Terminal block has no rendered bounds')
    }
    return orcaPage.screenshot({ clip })
  }
  const pixels = async (index: number) => decorationPixels(await screenshot(index))

  expect((await pixels(0)).redBelow).toBeGreaterThan(0)
  expect((await pixels(1)).redMiddle).toBeGreaterThan(0)
  const explicitUnderline = await pixels(2)
  expect(explicitUnderline.blueBelow).toBeGreaterThan(0)
  expect(explicitUnderline.redBelow).toBe(0)
  expect((await pixels(3)).redBelow).toBe(0)

  const linkBounds = await block(4).boundingBox()
  if (!linkBounds) {
    throw new Error('Terminal link has no rendered bounds')
  }
  await orcaPage.mouse.move(
    linkBounds.x + linkBounds.width / 2,
    linkBounds.y + linkBounds.height / 2
  )
  await expect
    .poll(async () => {
      const hovered = await pixels(4)
      return hovered.redBelow / hovered.width
    })
    .toBeGreaterThan(0.8)
  const screenshotPath = testInfo.outputPath('terminal-block-decorations.png')
  await orcaPage.screenshot({ path: screenshotPath })
  await testInfo.attach('terminal-block-decorations', {
    path: screenshotPath,
    contentType: 'image/png'
  })
})
