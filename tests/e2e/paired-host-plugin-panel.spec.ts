/**
 * Invariant: a plugin panel installed on this computer and on a paired host runs on the host
 * while the focused workspace is the host's: the host's worker answers it and the panel says so.
 * With no paired workspace focused it runs on this computer, as before.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { findPairedWorktreeId } from './helpers/paired-browser-placement-fixture'
import { enableDevPlugins } from './helpers/plugin-smoke'
import { pluginGuest, readInGuest, waitForGuestReady } from './helpers/plugin-frame-guest'
import type { RuntimeClient } from '../../src/cli/runtime/client'

const TITLE = 'Which Orca'

const PANEL_HTML = `<!doctype html>
<html><body>
<h1 id="home">…</h1>
<script type="module">
const answer = await window.orca.plugin.request('whoami', null)
document.getElementById('home').textContent = answer.home
window.__home = answer.home
</script>
</body></html>
`

const WORKER = `export default function activate(orca) {
  orca.panels.handle('whoami', () => ({ home: process.env.HOME ?? '' }))
}
`

async function writeWhichOrcaPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'panel.html'), PANEL_HTML)
  await writeFile(join(root, 'src', 'worker.js'), WORKER)
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      id: 'which-orca',
      publisher: 'samples',
      name: TITLE,
      version: '1.0.0',
      engines: { orca: '>=1.4.248' },
      execution: 'trusted-worker',
      pluginApi: 1,
      main: 'src/worker.js',
      contributes: {
        panels: [{ id: 'which', title: TITLE, icon: 'globe', entry: 'src/panel.html', ui: 'html' }]
      }
    })
  )
}

function approvalFingerprintOf(error: unknown): string | null {
  const data = typeof error === 'object' && error !== null && 'data' in error ? error.data : null
  const fingerprint =
    typeof data === 'object' && data !== null && 'approvalFingerprint' in data
      ? data.approvalFingerprint
      : null
  return typeof fingerprint === 'string' ? fingerprint : null
}

/** The host loads the same folder through the CLI's approve-by-fingerprint flow. */
async function loadOnHost(client: RuntimeClient, path: string): Promise<void> {
  await client.call('plugins.setSystemEnabled', { enabled: true })
  const approvalFingerprint = await client.call('plugins.devLoad', { path }).then(
    () => null,
    (error: unknown) => approvalFingerprintOf(error)
  )
  if (approvalFingerprint) {
    await client.call('plugins.devLoad', { path, approvalFingerprint })
  }
}

async function openPanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store?.getState()
    if (store && !store.rightSidebarOpen) {
      store.toggleRightSidebar()
    }
    await window.api.plugins.refresh()
  })
  const button = page.getByRole('button', { name: TITLE })
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()
}

function panelHome(page: Page): Promise<string | null> {
  return readInGuest<string>(pluginGuest(page, TITLE), 'window.__home ?? null')
}

test('a plugin panel runs on the paired host whose workspace is focused', async ({
  testRepoPath
}, testInfo) => {
  // Two Orca processes start (a headless host and a paired desktop client), and both load the plugin.
  test.setTimeout(300_000)
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-which-orca-'))
  await writeWhichOrcaPlugin(pluginRoot)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await loadOnHost(host.client, pluginRoot)
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const client = await launchPairedElectronClient(host.offer, testInfo, 'paired-host-panel', {
      extraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '1' }
    })
    try {
      const { page } = client
      const localHome = await client.app.evaluate(({ app }) => app.getPath('home'))
      await enableDevPlugins(page, [pluginRoot])

      await openPanel(page)
      const guest = pluginGuest(page, TITLE)
      await waitForGuestReady(guest)
      await expect.poll(() => panelHome(page), { timeout: 30_000 }).toBe(localHome)
      await expect(page.getByText(/^Running on /)).toHaveCount(0)

      const worktreeId = await findPairedWorktreeId(page, testRepoPath)
      await page.evaluate(
        ({ environmentId, id }) =>
          window.__store?.getState().setActiveWorktree(id, `runtime:${environmentId}`),
        { environmentId: client.environmentId, id: worktreeId }
      )
      const hostName = await page.evaluate(
        (id) =>
          window.__store
            ?.getState()
            .runtimeEnvironments.find((environment) => environment.id === id)?.name ?? '',
        client.environmentId
      )
      await expect(page.getByText(`Running on ${hostName}`)).toBeVisible({ timeout: 30_000 })
      await waitForGuestReady(pluginGuest(page, TITLE))
      await expect.poll(() => panelHome(page), { timeout: 30_000 }).toBe(host.env.HOME)
      await page.screenshot({ path: testInfo.outputPath('paired-host-panel.png') })
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
