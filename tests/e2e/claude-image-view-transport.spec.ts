import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { enableInlineImages, readInlineImageState } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

test('Claude image-view PNG bytes render while terminal-side file access stays unsupported', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await enableInlineImages(orcaPage)
  const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = identity.panes[0]?.ptyId
  if (!ptyId) {
    throw new Error('Image-view terminal did not bind its PTY')
  }
  const png = new PNG({ width: 120, height: 60 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([40, 40, 240, 255], i)
  }
  const imagePath = testInfo.outputPath('synthetic-image.png')
  const bytes = PNG.sync.write(png)
  writeFileSync(imagePath, bytes)
  const producerPath = testInfo.outputPath('image-view-transport.cjs')
  const before = `\x1bc\r\n[Image #1]\r\n\x1b_Ga=T,t=f,f=100,i=901,c=20,r=6,q=2;${Buffer.from(imagePath).toString('base64')}\x1b\\${'\r\n'.repeat(12)}FILE_TRANSPORT_DONE\r\n`
  const after = `\x1bc\r\n[Image #1]\r\n\x1b_Ga=T,t=d,f=100,i=902,c=20,r=6,q=2;${bytes.toString('base64')}\x1b\\${'\r\n'.repeat(12)}PNG_TRANSPORT_DONE\r\n`
  writeFileSync(
    producerPath,
    `process.stdout.write(Buffer.from(process.argv[2] === 'before' ? ${JSON.stringify(Buffer.from(before).toString('base64'))} : ${JSON.stringify(Buffer.from(after).toString('base64'))}, 'base64'))`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producerPath, 'before']))
  await waitForTerminalOutput(orcaPage, 'FILE_TRANSPORT_DONE', 30_000)
  await expect.poll(async () => (await readInlineImageState(orcaPage))?.images).toBe(0)
  const terminalBounds = await orcaPage.locator('.xterm-screen').first().boundingBox()
  if (!terminalBounds) {
    throw new Error('Image-view terminal has no render bounds')
  }
  const clip = {
    ...terminalBounds,
    width: Math.min(terminalBounds.width, 360),
    height: Math.min(terminalBounds.height, 160)
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('image-view-before.png'), clip })
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producerPath, 'after']))
  await waitForTerminalOutput(orcaPage, 'PNG_TRANSPORT_DONE', 30_000)
  await expect.poll(async () => (await readInlineImageState(orcaPage))?.images).toBe(1)
  await expect
    .poll(async () => {
      const rendered = PNG.sync.read(
        await orcaPage.screenshot({ path: testInfo.outputPath('image-view-after.png'), clip })
      )
      let bluePixels = 0
      for (let i = 0; i < rendered.data.length; i += 4) {
        const [r, g, b] = rendered.data.subarray(i, i + 3)
        if (r < 60 && g < 60 && b > 220) {
          bluePixels++
        }
      }
      return bluePixels
    })
    .toBeGreaterThan(1000)
})
