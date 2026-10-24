import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import { enableInlineImages, inlineImagePayload } from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})

test('Kitty Unicode images survive renderer reload without producer retransmission', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await enableInlineImages(orcaPage)
  const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = identity.panes[0]?.ptyId
  if (!ptyId) {
    throw new Error('Missing test PTY')
  }
  const producer = testInfo.outputPath('kitty-image.cjs')
  const payload = inlineImagePayload(true)
  const kittyOnly = `\x1bc${payload.slice(payload.indexOf('Kitty placeholders:'))}`
  writeFileSync(
    producer,
    `process.stdout.write(Buffer.from('${Buffer.from(kittyOnly).toString('base64')}', 'base64')); console.log('KITTY_REPLAY_' + 'READY')`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
  await waitForTerminalOutput(orcaPage, 'KITTY_REPLAY_READY')
  const imagePixels = async (name: string) => {
    const png = PNG.sync.read(
      await orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
    )
    let orange = 0
    for (let i = 0; i < png.data.length; i += 4) {
      if (
        png.data[i]! > 220 &&
        png.data[i + 1]! > 130 &&
        png.data[i + 1]! < 190 &&
        png.data[i + 2]! < 60
      ) {
        orange++
      }
    }
    return orange
  }
  await expect.poll(() => imagePixels('before-reload')).toBeGreaterThan(1000)
  await expect
    .poll(() =>
      orcaPage.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('orca-terminal-kitty-replay')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          return await new Promise<number>((resolve, reject) => {
            const request = db.transaction('images').objectStore('images').count()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        } finally {
          db.close()
        }
      })
    )
    .toBeGreaterThan(0)
  for (let attempt = 0; attempt < 3; attempt++) {
    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await expect
      .poll(() => imagePixels(`after-reload-${attempt}`), { timeout: 30_000 })
      .toBeGreaterThan(1000)
    const restored = await waitForPaneIdentitySnapshot(orcaPage, 1)
    expect(restored.panes[0]?.ptyId).toBe(ptyId)
    await orcaPage.screenshot({
      path: testInfo.outputPath('review-proof.png'),
      clip: { x: 280, y: 20, width: 800, height: 85 }
    })
  }
})
