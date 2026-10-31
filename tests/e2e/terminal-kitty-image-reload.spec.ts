import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
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

type KittyWriteAbortProbe = { aborted: number; restore(): void }
type KittyColdReadProbe = { completed: number; found: boolean }

declare global {
  var __orcaKittyWriteAbort: KittyWriteAbortProbe | undefined
  var __orcaKittyColdRead: KittyColdReadProbe | undefined
}

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})

async function orangeImagePixels(page: Page, screenshotPath: string): Promise<number> {
  const png = PNG.sync.read(
    await page.locator('.pane:visible .xterm-screen').first().screenshot({ path: screenshotPath })
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

function cachedKittyImageState(page: Page): Promise<{ images: number; placements: number }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open('orca-terminal-kitty-replay')
      request.onupgradeneeded = () => request.transaction?.abort()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
    if (!db) {
      return { images: 0, placements: 0 }
    }
    try {
      return await new Promise<{ images: number; placements: number }>((resolve, reject) => {
        const request = db.transaction('images').objectStore('images').getAll()
        request.onsuccess = () => {
          const records: unknown[] = request.result
          const record = records.find(
            (value) => value && typeof value === 'object' && 'id' in value && value.id === 65280
          )
          const snapshot =
            record && typeof record === 'object' && 'snapshot' in record ? record.snapshot : null
          const placements =
            snapshot &&
            typeof snapshot === 'object' &&
            'placements' in snapshot &&
            Array.isArray(snapshot.placements)
              ? snapshot.placements.length
              : 0
          resolve({ images: records.length, placements })
        }
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}

async function cachedKittyImageCount(page: Page): Promise<number> {
  return (await cachedKittyImageState(page)).images
}

for (const selector of ['i', 'I']) {
  test(`named physical Kitty placement disappears on d=${selector}`, async ({
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
    const png = new PNG({ width: 120, height: 36 })
    for (let i = 0; i < png.data.length; i += 4) {
      png.data.set([240, 160, 40, 255], i)
    }
    const producer = testInfo.outputPath('named-physical-image.cjs')
    writeFileSync(
      producer,
      "process.stdout.write(Buffer.from(process.argv[2], 'base64')); console.log('NAMED_PHYSICAL_' + process.argv[3])"
    )
    const image = `\x1b_Ga=T,f=100,i=77,p=10,q=2;${PNG.sync.write(png).toString('base64')}\x1b\\`
    await execInTerminal(
      orcaPage,
      ptyId,
      nodeTerminalCommand([producer, Buffer.from(image).toString('base64'), 'SHOWN'])
    )
    await waitForTerminalOutput(orcaPage, 'NAMED_PHYSICAL_SHOWN')
    await expect
      .poll(() => orangeImagePixels(orcaPage, testInfo.outputPath('before-delete.png')))
      .toBeGreaterThan(1000)

    const deletion = `\x1b_Ga=d,d=${selector},i=77,p=10,q=2;\x1b\\`
    await execInTerminal(
      orcaPage,
      ptyId,
      nodeTerminalCommand([producer, Buffer.from(deletion).toString('base64'), 'DELETED'])
    )
    await waitForTerminalOutput(orcaPage, 'NAMED_PHYSICAL_DELETED')
    await expect
      .poll(() => orangeImagePixels(orcaPage, testInfo.outputPath('after-delete.png')))
      .toBeLessThan(50)
  })
}

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
  const cachedImages = () => cachedKittyImageCount(orcaPage)
  expect(await cachedImages()).toBe(0)
  const producer = testInfo.outputPath('kitty-image.cjs')
  const payload = inlineImagePayload(true)
  const kittyOnly = `\x1bc${payload.slice(payload.indexOf('Kitty placeholders:'))}`
  writeFileSync(
    producer,
    `process.stdout.write(Buffer.from('${Buffer.from(kittyOnly).toString('base64')}', 'base64')); console.log('KITTY_REPLAY_' + 'READY')`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer]))
  await waitForTerminalOutput(orcaPage, 'KITTY_REPLAY_READY')
  const imagePixels = (name: string) =>
    orangeImagePixels(orcaPage, testInfo.outputPath(`${name}.png`))
  await expect.poll(() => imagePixels('before-reload')).toBeGreaterThan(1000)
  await expect.poll(cachedImages).toBeGreaterThan(0)
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

test('does not restore a stale Kitty snapshot after an image-write transaction aborts', async ({
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
  expect(await cachedKittyImageCount(orcaPage)).toBe(0)
  const producer = testInfo.outputPath('cache-write-abort.cjs')
  const payload = inlineImagePayload(true)
  const kittyOnly = `\x1bc${payload.slice(payload.indexOf('Kitty placeholders:'))}`
  writeFileSync(
    producer,
    `const phase = process.argv[2]; process.stdout.write(Buffer.from(phase === 'READY' ? '${Buffer.from(kittyOnly).toString('base64')}' : process.argv[3], 'base64')); console.log('KITTY_CACHE_' + phase)`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'READY']))
  await waitForTerminalOutput(orcaPage, 'KITTY_CACHE_READY')
  await expect
    .poll(() => orangeImagePixels(orcaPage, testInfo.outputPath('before-write-abort.png')))
    .toBeGreaterThan(1000)
  await expect.poll(() => cachedKittyImageCount(orcaPage)).toBe(1)
  await execInTerminal(
    orcaPage,
    ptyId,
    nodeTerminalCommand([
      producer,
      'PLACED',
      Buffer.from('\x1b_Ga=p,i=65280,p=1,U=1,c=14,r=3,q=2;\x1b\\').toString('base64')
    ])
  )
  await waitForTerminalOutput(orcaPage, 'KITTY_CACHE_PLACED')
  await expect.poll(async () => (await cachedKittyImageState(orcaPage)).placements).toBe(2)
  const observation: Record<string, unknown> = {
    imageId: 65280,
    persistedBeforeAbort: await cachedKittyImageState(orcaPage),
    nativeTransactionAbortInjected: true,
    actualQuotaExhaustion: false,
    ptyBeforeReload: ptyId
  }
  await orcaPage.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    const control = { aborted: 0, restore: () => (IDBObjectStore.prototype.put = put) }
    globalThis.__orcaKittyWriteAbort = control
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      if (this.name === 'images' && this.transaction.db.name === 'orca-terminal-kitty-replay') {
        control.aborted++
        this.transaction.abort()
        throw new DOMException('controlled cached-image write abort', 'AbortError')
      }
      return put.call(this, value, key)
    }
  })
  const abortedWrites = () =>
    orcaPage.evaluate(() => globalThis.__orcaKittyWriteAbort?.aborted ?? 0)
  try {
    await execInTerminal(
      orcaPage,
      ptyId,
      nodeTerminalCommand([
        producer,
        'DELETED',
        Buffer.from('\x1b_Ga=d,d=i,i=65280,p=0,q=2;\x1b\\').toString('base64')
      ])
    )
    await waitForTerminalOutput(orcaPage, 'KITTY_CACHE_DELETED')
    await expect.poll(abortedWrites).toBeGreaterThan(0)
    observation.abortedWrites = await abortedWrites()
    observation.persistedImagesAfterAbort = await cachedKittyImageCount(orcaPage)
    expect.soft(observation.persistedImagesAfterAbort).toBe(0)
    await expect
      .poll(async () => {
        const pixels = await orangeImagePixels(
          orcaPage,
          testInfo.outputPath('live-after-write-abort.png')
        )
        observation.livePixelsAfterAbort = pixels
        return pixels
      })
      .toBeGreaterThan(1000)
    await orcaPage.addInitScript(() => {
      const get = IDBObjectStore.prototype.get
      const probe = { completed: 0, found: false }
      globalThis.__orcaKittyColdRead = probe
      IDBObjectStore.prototype.get = function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange
      ) {
        const request = get.call(this, query)
        if (
          this.name === 'images' &&
          this.transaction.db.name === 'orca-terminal-kitty-replay' &&
          Array.isArray(query) &&
          query[1] === 65280
        ) {
          request.addEventListener('success', () => {
            probe.completed++
            probe.found ||= request.result !== undefined
          })
        }
        return request
      }
    })
    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await waitForTerminalOutput(orcaPage, 'KITTY_CACHE_DELETED')
    const coldRead = () =>
      orcaPage.evaluate(() => globalThis.__orcaKittyColdRead ?? { completed: 0, found: false })
    await expect.poll(async () => (await coldRead()).completed).toBeGreaterThan(0)
    const lookup = await coldRead()
    observation.coldRead = lookup
    expect.soft(lookup.found).toBe(false)
    const restored = await waitForPaneIdentitySnapshot(orcaPage, 1)
    observation.ptyAfterReload = restored.panes[0]?.ptyId
    expect(restored.panes[0]?.ptyId).toBe(ptyId)
    if (lookup.found) {
      await expect
        .poll(() => orangeImagePixels(orcaPage, testInfo.outputPath('after-abort-reload.png')))
        .toBeGreaterThan(1000)
    }
    await expect
      .poll(
        async () => {
          const pixels = await orangeImagePixels(
            orcaPage,
            testInfo.outputPath('after-abort-reload.png')
          )
          observation.pixelsAfterReload = pixels
          return pixels
        },
        { timeout: 30_000 }
      )
      .toBeLessThan(50)
  } finally {
    writeFileSync(
      testInfo.outputPath('native-write-abort-observation.json'),
      JSON.stringify(observation, null, 2)
    )
    await orcaPage.evaluate(() => globalThis.__orcaKittyWriteAbort?.restore())
  }
})
