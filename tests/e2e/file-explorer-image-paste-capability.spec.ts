import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getOwnedTempStagingRoot } from '../../src/main/window/owned-temp-staging-root'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY
} from '../../src/shared/protocol-version'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  installImagePasteClipboard,
  observeHostImageCommits
} from './helpers/paired-image-paste-probes'
import {
  omitHostImagePasteCapability,
  observeImagePasteStaging
} from './helpers/image-paste-capability-probes'

test('refuses image paste when the paired host lacks existing-parent support', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const folderName = 'unsupported image á'
  const destination = path.join(testRepoPath, folderName)
  await mkdir(destination)
  const sentinel = Buffer.from('Existing file must survive unsupported image paste')
  await writeFile(path.join(destination, 'pasted-image.png'), sentinel)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | undefined
  try {
    const capability = await omitHostImagePasteCapability(host.app)
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'folder' })
      client = await launchPairedElectronClient(
        host.offer,
        testInfo,
        'Host without image paste support'
      )
      const { page, app } = client
      // Hidden renderers can leave compositor transitions paused throughout a toast's lifetime.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForFunction(
        (root) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .some((entry) => entry.path === root),
        testRepoPath,
        { timeout: 60_000 }
      )
      await page.evaluate(
        ({ root, environmentId }) => {
          const state = window.__store!.getState()
          const worktree = state.allWorktrees().find((entry) => entry.path === root)
          if (!worktree) {
            throw new Error('Host workspace unavailable')
          }
          state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
        },
        { root: testRepoPath, environmentId: client.environmentId }
      )
      const status = await page.evaluate(async (environmentId) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'status.get',
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      }, client.environmentId)
      expect(status).toMatchObject({
        capabilities: expect.arrayContaining([FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY])
      })
      expect(status).not.toMatchObject({
        capabilities: expect.arrayContaining([FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY])
      })
      await openFileExplorer(page)
      const folder = page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(folderName, { exact: true }) })
      await expect(folder).toBeVisible({ timeout: 30_000 })
      const clipboard = await installImagePasteClipboard(app)
      const staging = await observeImagePasteStaging(app)
      const writes = await observeHostImageCommits(host.app, destination)
      try {
        const stagingRoot = getOwnedTempStagingRoot(client.userDataDir, 'clipboard-image-imports')
        const message = 'Pasting images requires a newer Orca server. Update the HUB and try again.'
        const errors = page.locator('[data-sonner-toast]').filter({ hasText: message })
        for (const [index, gesture] of ['keyboard', 'menu'].entries()) {
          await folder.click()
          if (gesture === 'keyboard') {
            await folder.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
          } else {
            await folder.click({ button: 'right' })
            await page.getByRole('menuitem', { name: /Paste Image/ }).click()
          }
          await expect(errors.last()).toBeVisible()
          await expect(errors.last()).toHaveCSS('opacity', '1')
          const errorBounds = await errors.last().boundingBox()
          if (!errorBounds) {
            throw new Error('Visible image paste error has no bounds')
          }
          // Capture without scrolling a short-lived toast while the hidden compositor settles.
          await page.screenshot({
            path: testInfo.outputPath(`unsupported-error-${gesture}.png`),
            clip: errorBounds,
            animations: 'disabled'
          })
          await expect
            .poll(() => staging.evaluate((probe) => probe.releases.length))
            .toBe(index + 1)
          const snapshots = await staging.evaluate((probe) => ({
            stages: probe.stages,
            releases: probe.releases
          }))
          expect(snapshots.stages).toHaveLength(index + 1)
          expect(snapshots.releases).toEqual(snapshots.stages.map((entry) => entry.handle))
          await expect.poll(() => readdir(stagingRoot)).toEqual([])
          expect(await readdir(destination)).toEqual(['pasted-image.png'])
          expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(sentinel)
          expect(await writes.evaluate((probe) => probe.commits)).toEqual([])
          await expect(folder).toHaveAttribute('data-selected', 'true')
          await page.screenshot({ path: testInfo.outputPath(`unsupported-image-${gesture}.png`) })
          // Each gesture must produce its own visible error, not reuse the previous toast.
          await expect(errors).toHaveCount(0, { timeout: 15_000 })
        }
        await testInfo.attach('unsupported-image-paste.json', {
          body: JSON.stringify(
            {
              platform: process.platform,
              transport: 'paired runtime over loopback; capability omitted in disposable host',
              historicalBinary: false,
              reducedMotion: true,
              missingCapability: FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY,
              message,
              gestures: ['keyboard', 'menu'],
              staging: await staging.evaluate((probe) => ({
                stages: probe.stages,
                releases: probe.releases
              })),
              hostCommits: await writes.evaluate((probe) => probe.commits),
              destinationFiles: await readdir(destination),
              clientStagingEmpty: true,
              existingFileUnchanged: true
            },
            null,
            2
          ),
          contentType: 'application/json'
        })
      } finally {
        await staging.evaluate((probe) => {
          probe.restore()
        })
        await clipboard.evaluate((probe) => {
          probe.restore()
        })
        await writes.evaluate((probe) => {
          probe.restore()
        })
        await staging.dispose()
        await clipboard.dispose()
        await writes.dispose()
      }
    } finally {
      await capability.evaluate((probe) => {
        probe.restore()
      })
      await capability.dispose()
    }
  } finally {
    try {
      await client?.dispose()
    } finally {
      await host.dispose()
    }
  }
})
