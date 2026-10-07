import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import type { readTerminalModelCheckpoint } from '../../src/shared/terminal-model-checkpoint-reader'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  enableInlineImages,
  inlineImageProducer
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Global Window augmentation requires an interface.
  interface Window {
    CheckpointReaderProof: { readTerminalModelCheckpoint: typeof readTerminalModelCheckpoint }
  }
}

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: copies inline image resources through authenticated local IPC`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await enableInlineImages(orcaPage)
    await orcaPage.evaluate(
      async ({ policy, worktree }) => {
        const store = window.__store!.getState()
        await store.updateSettings({ terminalGpuAcceleration: policy })
        const tab = store.createTab(worktree)
        window.__store!.getState().setActiveTab(tab.id)
      },
      { policy: acceleration, worktree: worktreeId }
    )
    await waitForActiveTerminalManager(orcaPage, 30_000)
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
    const producer = testInfo.outputPath('image-model-transfer.cjs')
    writeFileSync(producer, inlineImageProducer(true))
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'MODEL_TRANSFER']))
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_MODEL_TRANSFER', 30_000)
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('protocols-before-transfer.png'))
    await assertKittyPlaceholderPixels(
      orcaPage,
      testInfo.outputPath('placeholder-before-transfer.png')
    )
    const visible = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
    expect(visible).toBe(false)
    const readerBundle = testInfo.outputPath('model-checkpoint-reader.js')
    await build({
      entryPoints: [path.resolve('src/shared/terminal-model-checkpoint-reader.ts')],
      outfile: readerBundle,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'CheckpointReaderProof',
      logLevel: 'silent'
    })
    await orcaPage.addScriptTag({ path: readerBundle })
    const result = await orcaPage.evaluate(async (worktree) => {
      const tabId = window.__store!.getState().activeTabId
      const pane = tabId && window.__paneManagers?.get(tabId)?.getActivePane()
      if (!pane || !tabId) {
        throw new Error('Missing active image pane')
      }
      // Stable-owner attach proves the current incarnation without creating another process.
      const attached = await window.api.pty.spawn({
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        worktreeId: worktree,
        tabId,
        leafId: pane.leafId
      })
      if (!attached.incarnationId || !attached.isReattach) {
        throw new Error('Expected live owner attach')
      }
      const { captureModelCheckpoint, readModelCheckpoint, releaseModelCheckpoint } = window.api.pty
      if (!captureModelCheckpoint || !readModelCheckpoint || !releaseModelCheckpoint) {
        throw new Error('Missing model checkpoint API')
      }
      let leaseId: string | undefined
      let released = false
      const received = await window.CheckpointReaderProof.readTerminalModelCheckpoint(
        {
          captureModelCheckpoint: async (id, incarnation) => {
            const lease = await captureModelCheckpoint(id, incarnation)
            leaseId = lease?.leaseId
            return lease
          },
          readModelCheckpoint,
          releaseModelCheckpoint: async (id, lease) => {
            released = await releaseModelCheckpoint(id, lease)
            return released
          }
        },
        attached.id,
        attached.incarnationId,
        () => true
      )
      if (!received || !leaseId) {
        throw new Error('Missing image model transfer')
      }
      try {
        let hostRetired = false
        try {
          await readModelCheckpoint(attached.id, {
            leaseId,
            resourceId: null,
            offset: 0,
            length: 1
          })
        } catch {
          hostRetired = true
        }
        const checkpoint = received.checkpoint
        const resources = checkpoint.metadata.graphics.resources.map((resource) => ({
          id: resource.id,
          byteLength: checkpoint.copyResource(resource.id, resource.byteLength).byteLength
        }))
        return {
          id: attached.id,
          sourceSeq: received.sourceSeq,
          released,
          hostRetired,
          components: checkpoint.metadata.graphics.components.map((part) => part.kind),
          resources
        }
      } finally {
        received.checkpoint.dispose()
      }
    }, worktreeId)
    expect(result.id).toBe(ptyId)
    expect(result.released && result.hostRetired).toBe(true)
    expect(result.resources.some((resource) => resource.byteLength > 0)).toBe(true)
    expect(result.components).toContain('decoded')
    expect(result.components).toContain('kitty-sources')
    writeFileSync(
      testInfo.outputPath('model-transfer.json'),
      JSON.stringify({ acceleration, visible, ...result }, null, 2)
    )
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('protocols-after-transfer.png'))
    await assertKittyPlaceholderPixels(
      orcaPage,
      testInfo.outputPath('placeholder-after-transfer.png')
    )
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_MODEL_TRANSFER', 30_000)
  })
}
