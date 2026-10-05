import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodePairingOffer } from '../../src/shared/pairing'
import { test, expect } from './helpers/orca-app'

declare global {
  var __revealedPaths: string[] | undefined
}

test.use({ seedTestRepo: false })

test('Reveal in Finder opens a local file while a remote runtime is selected', async ({
  electronApp,
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orca-reveal-local-'))
  registerPostElectronShutdownCleanup(() => rm(folder, { recursive: true, force: true }))
  await writeFile(path.join(folder, 'reveal-me.md'), 'local file\n')
  await page.evaluate(async (folder) => {
    await window.__store!.getState().addRepoPath(folder, 'folder')
  }, folder)
  await page
    .getByRole('option')
    .filter({ hasText: path.basename(folder) })
    .click()
  const row = page
    .locator('[data-orca-explorer-shell]')
    .getByRole('button', { name: 'reveal-me.md', exact: true })
  await expect(row).toBeVisible()

  // Why: record reveals in main instead of opening a real file manager window.
  await electronApp.evaluate(({ shell }) => {
    globalThis.__revealedPaths = []
    shell.showItemInFolder = (fullPath) => void globalThis.__revealedPaths!.push(fullPath)
  })
  // Why: ownership must not depend on reachability, so an unreachable runtime is enough.
  const pairingCode = encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:9',
    deviceToken: 'e2e-device-token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  })
  await page.evaluate(async (pairingCode) => {
    const { environment } = await window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Unreachable runtime',
      pairingCode
    })
    await window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: environment.id
    })
    window.__store!.setState((current) => ({
      settings: { ...current.settings!, activeRuntimeEnvironmentId: environment.id }
    }))
  }, pairingCode)

  await row.click({ button: 'right' })
  await page
    .getByRole('menuitem', {
      name: /Reveal in Finder|Open Containing Folder|Reveal in File Explorer/
    })
    .click()

  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__revealedPaths))
    .toEqual([expect.stringMatching(/reveal-me\.md$/)])
  await expect(
    page.getByText('Opening remote paths in the local OS is not available.')
  ).toHaveCount(0)
})
