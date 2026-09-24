import type { Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertInlineImagePixels,
  enableInlineImages,
  inlineImageProducer,
  readInlineImageResources,
  readInlineImageState
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

const TAB_COUNT = 12
const CYCLES = 2

test.use({ orcaAppExtraArgs: ['--enable-precise-memory-info'] })

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.__store!.getState().setActiveTab(id), tabId)
  await expect.poll(() => page.evaluate(() => window.__store!.getState().activeTabId)).toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
}

test('twelve image terminals release decoder and image storage across reset and close cycles', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(360_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalHiddenViewParking: false })
  })
  await enableInlineImages(orcaPage)
  const baselineTabId = (await waitForPaneIdentitySnapshot(orcaPage, 1)).tabId
  const producerPath = testInfo.outputPath('image-retention-producer.cjs')
  writeFileSync(
    producerPath,
    [
      inlineImageProducer(),
      'for (let id = 100; id < 106; id++) {',
      "process.stdout.write('\\x1b_Ga=t,f=32,s=1,v=1,i=' + id + ',m=1,q=2;AAAA\\x1b\\\\')",
      '}',
      "console.log('RETENTION_DONE_' + process.argv[2])"
    ].join('\n')
  )
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const samples: unknown[] = []
  const sampleHeap = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    return cdp.send('Runtime.getHeapUsage')
  }
  const baseline = await sampleHeap()
  samples.push({ stage: 'baseline', heap: baseline })
  const outstandingTabs = new Set<string>()
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const tabs: { id: string; ptyId: string }[] = []
      for (let index = 0; index < TAB_COUNT; index++) {
        const id = await orcaPage.evaluate((worktree) => {
          const state = window.__store!.getState()
          const tab = state.createTab(worktree, undefined, undefined, { activate: true })
          state.setActiveTab(tab.id)
          state.setActiveTabType('terminal')
          return tab.id
        }, worktreeId)
        outstandingTabs.add(id)
        await activateTab(orcaPage, id)
        const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
        expect(identity.tabId).toBe(id)
        const ptyId = identity.panes[0]?.ptyId
        if (!ptyId) {
          throw new Error('Image stress terminal did not bind its PTY')
        }
        tabs.push({ id, ptyId })
        await expect.poll(() => readInlineImageState(orcaPage), { timeout: 30_000 }).not.toBeNull()
        const marker = `${cycle}_${index}`
        await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producerPath, marker]))
        await waitForTerminalOutput(orcaPage, `RETENTION_DONE_${marker}`, 30_000)
        await expect.poll(async () => (await readInlineImageState(orcaPage))?.pending).toBe(2)
        if (index === TAB_COUNT - 1) {
          await assertInlineImagePixels(orcaPage, testInfo.outputPath(`cycle-${cycle}-images.png`))
        }
      }
      const loaded = await readInlineImageResources(
        orcaPage,
        tabs.map((tab) => tab.id)
      )
      expect(loaded).toHaveLength(TAB_COUNT)
      for (const resource of loaded) {
        expect(resource.mounted).toBe(true)
        expect(resource.addon).toBe(true)
        expect(resource.images).toBeGreaterThanOrEqual(3)
        expect(resource.pending).toBe(2)
        expect(resource.decoderBytes).toBeGreaterThan(0)
        expect(resource.decoderBytes).toBeLessThanOrEqual(32_000_000)
        expect(resource.blobBytes).toBeLessThanOrEqual(32_000_000)
        expect(resource.storageMB).toBeLessThanOrEqual(32)
      }
      samples.push({ stage: `cycle-${cycle}-loaded`, resources: loaded, heap: await sampleHeap() })
      for (const tab of tabs) {
        await activateTab(orcaPage, tab.id)
        await execInTerminal(
          orcaPage,
          tab.ptyId,
          nodeTerminalCommand([
            '-e',
            "process.stdout.write('\\x1bc'); console.log('RESET_' + 'DONE')"
          ])
        )
        await waitForTerminalOutput(orcaPage, 'RESET_DONE', 30_000)
        await expect
          .poll(async () => {
            const [resource] = await readInlineImageResources(orcaPage, [tab.id])
            return {
              images: resource.images,
              pending: resource.pending,
              decoderBytes: resource.decoderBytes,
              blobBytes: resource.blobBytes
            }
          })
          .toEqual({ images: 0, pending: 0, decoderBytes: 0, blobBytes: 0 })
      }
      samples.push({
        stage: `cycle-${cycle}-reset`,
        resources: await readInlineImageResources(
          orcaPage,
          tabs.map((tab) => tab.id)
        ),
        heap: await sampleHeap()
      })
      await activateTab(orcaPage, baselineTabId)
      for (const tab of tabs) {
        await orcaPage.evaluate((id) => window.__store!.getState().closeTab(id), tab.id)
      }
      await expect
        .poll(
          async () =>
            (
              await readInlineImageResources(
                orcaPage,
                tabs.map((tab) => tab.id)
              )
            ).filter((resource) => resource.mounted).length,
          { timeout: 30_000 }
        )
        .toBe(0)
      for (const tab of tabs) {
        outstandingTabs.delete(tab.id)
      }
      const closed = await sampleHeap()
      samples.push({ stage: `cycle-${cycle}-closed`, heap: closed })
      // GC heap/backing storage catch retained owners without requiring allocator RSS to fall.
      expect(closed.usedSize).toBeLessThanOrEqual(baseline.usedSize + 64_000_000)
      // Assert presence rather than guarding on it: a CDP field that stops being
      // reported would otherwise delete this leak check and still pass.
      expect(baseline.backingStorageSize).toBeDefined()
      expect(closed.backingStorageSize).toBeDefined()
      expect(closed.backingStorageSize!).toBeLessThanOrEqual(
        baseline.backingStorageSize! + 32_000_000
      )
    }
  } finally {
    for (const id of outstandingTabs) {
      await orcaPage
        .evaluate((tab) => window.__store!.getState().closeTab(tab), id)
        .catch(() => undefined)
    }
    writeFileSync(testInfo.outputPath('memory-measurements.json'), JSON.stringify(samples, null, 2))
    await testInfo.attach('inline-image-retention-measurements', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json'
    })
    await cdp.detach()
  }
})
