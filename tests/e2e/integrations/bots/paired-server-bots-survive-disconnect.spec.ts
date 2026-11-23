// A paired server's bots stay listed, dimmed, when the server goes away, in the session and across a desktop restart.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pairedOwnerApp } from './paired-owner-app'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { launchHeadlessPairedRuntimeHost } from '../../remote/paired-runtime/client-hosts/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from '../../remote/paired-runtime/client-hosts/paired-electron-client'

const HOST_NAME = 'g16'
const BOT_NAME = 'windows bot 2'

function botRow(client: PairedElectronClient): ReturnType<PairedElectronClient['page']['locator']> {
  return client.page.locator('[data-bot-sidebar-list]').getByText(BOT_NAME, { exact: true })
}

// oxlint-disable-next-line no-empty-pattern -- Owns the host and client launches; Playwright needs the fixtures argument.
test('a disconnected paired server keeps its bots listed, offline, through a window reload', async ({}, testInfo) => {
  // A headless serve host, a paired desktop and a reload, each with its own startup wait.
  test.setTimeout(360_000)
  const ownerDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-bot-owner-'))
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let hostUp = true
  try {
    // As the owner's app makes one, paired over the server's offer; a local CLI caller only proposes.
    const owner = pairedOwnerApp(ownerDir, host.offer.pairingUrl)
    await owner.call('bots.create', { name: BOT_NAME, agent: 'claude' })
    client = await launchPairedElectronClient(host.offer, testInfo, HOST_NAME)
    await expect(botRow(client)).toBeVisible({ timeout: 90_000 })

    await host.dispose()
    hostUp = false
    await expect
      .poll(
        () =>
          client!.page.evaluate(
            (id) => window.__store?.getState().runtimeStatusByEnvironmentId.get(id)?.status ?? null,
            client!.environmentId
          ),
        { timeout: 90_000 }
      )
      .toBeNull()
    await expect(botRow(client)).toBeVisible()
    // A reload drops every renderer copy, as an app restart does, while the server is still away.
    await client.page.reload()
    await client.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    await expect(botRow(client)).toBeVisible({ timeout: 60_000 })
    await client.page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await expect(client.page.locator('html')).toHaveClass(/dark/)
    const file = testInfo.outputPath('offline-bot-row.png')
    await client.page.locator('[data-bot-sidebar-list]').screenshot({ path: file })
    await testInfo.attach('offline-bot-row', { path: file, contentType: 'image/png' })
  } finally {
    await client?.dispose()
    if (hostUp) {
      await host.dispose()
    }
    rmSync(ownerDir, { recursive: true, force: true })
  }
})
