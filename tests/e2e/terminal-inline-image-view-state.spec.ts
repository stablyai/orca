import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertKittyPlaceholderPixels,
  enableInlineImages,
  inlineImageProducer
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: placeholder pixels survive scroll, font zoom, and a tab switch without retransmission`, async ({
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
    const tabId = await orcaPage.evaluate(() => window.__store!.getState().activeTabId)
    if (!tabId) {
      throw new Error('Missing image tab')
    }
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const producer = testInfo.outputPath('image-view-state.cjs')
    writeFileSync(producer, inlineImageProducer(true))
    await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'VIEW_STATE']))
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_VIEW_STATE', 30_000)
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('initial.png'))

    await execInTerminal(
      orcaPage,
      ptyId,
      nodeTerminalCommand([
        '-e',
        "process.stdout.write('\\r\\n'.repeat(100)); console.log('SCROLL_' + 'DONE')"
      ])
    )
    await waitForTerminalOutput(orcaPage, 'SCROLL_DONE', 30_000)
    const showImageRows = async () => {
      await orcaPage.evaluate(() => {
        const tab = window.__store!.getState().activeTabId
        const terminal = tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal
        if (!terminal) {
          throw new Error('Missing view-state terminal')
        }
        const buffer = terminal.buffer.active
        for (let row = 0; row < buffer.length; row++) {
          if (buffer.getLine(row)?.translateToString().includes('\u{10EEEE}')) {
            terminal.scrollToLine(Math.max(0, row - 2))
            return
          }
        }
        throw new Error('Placeholder text disappeared from scrollback')
      })
    }
    await showImageRows()
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('scrolled-back.png'))
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalFontSize: 28 })
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const tab = window.__store!.getState().activeTabId
          return tab && window.__paneManagers?.get(tab)?.getActivePane()?.terminal.options.fontSize
        })
      )
      .toBe(28)
    await showImageRows()
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('font-zoom.png'))

    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('Missing view-state workspace')
      }
      const tab = state.createTab(worktreeId)
      window.__store!.getState().setActiveTab(tab.id)
    })
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
    await orcaPage.evaluate((id) => window.__store!.getState().setActiveTab(id), tabId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await showImageRows()
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('tab-return.png'))
  })
}
