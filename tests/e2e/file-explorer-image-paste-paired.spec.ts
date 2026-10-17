import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { getOwnedTempStagingRoot } from '../../src/main/window/owned-temp-staging-root'
import { FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
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

test('pastes an image through a paired runtime and cleans both staging locations', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const folderName = 'paired image á'
  const destination = path.join(testRepoPath, folderName)
  await mkdir(destination)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | undefined
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'folder' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Image paste host')
    const { page, app } = client
    expect(app.process().pid).not.toBe(host.app.process().pid)
    expect(client.userDataDir).not.toBe(host.userDataDir)
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
      capabilities: expect.arrayContaining([FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY])
    })
    await openFileExplorer(page)
    const row = (name: string) =>
      page.locator('[data-file-explorer-row]').filter({
        has: page.getByText(name, { exact: true })
      })
    const folder = row(folderName)
    await expect(folder).toBeVisible({ timeout: 30_000 })
    const clipboard = await installImagePasteClipboard(app)
    const hostWrites = await observeHostImageCommits(host.app, destination)
    try {
      const expectedPng = await clipboard.evaluate((probe) => probe.png)
      const expected = Buffer.from(expectedPng, 'base64')
      await folder.click()
      await folder.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
      const first = row('pasted-image.png')
      await expect(first).toBeVisible({ timeout: 30_000 })
      await expect(first).toHaveAttribute('data-selected', 'true')
      expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(expected)

      await first.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Paste Image/ }).click()
      const second = row('pasted-image copy.png')
      await expect(second).toBeVisible({ timeout: 30_000 })
      await expect(second).toHaveAttribute('data-selected', 'true')
      expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(expected)
      expect(await readFile(path.join(destination, 'pasted-image copy.png'))).toEqual(expected)
      await expect
        .poll(() => readdir(destination).then((names) => names.sort()))
        .toEqual(['pasted-image copy.png', 'pasted-image.png'])

      // Observe the host process: a local fallback could also write into this loopback fixture.
      const commits = await hostWrites.evaluate((probe) => probe.commits)
      expect(commits).toHaveLength(2)
      for (const commit of commits) {
        expect(path.dirname(commit.source)).toBe(destination)
        expect(path.basename(commit.source)).toMatch(/^\.pasted-image.*\.orca-upload-/)
        expect(commit.png).toBe(expectedPng)
      }
      expect(commits.map((commit) => path.basename(commit.destination))).toEqual([
        'pasted-image.png',
        'pasted-image copy.png'
      ])
      const staging = getOwnedTempStagingRoot(client.userDataDir, 'clipboard-image-imports')
      await expect.poll(() => readdir(staging).then((entries) => entries.length)).toBe(2)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menuitem', { name: /Paste Image/ })).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('paired-image-paste.png') })
      const chord = process.platform === 'darwin' ? 'Meta' : 'Control'
      await row('pasted-image copy.png').focus()
      await page.keyboard.press(`${chord}+z`)
      await expect.poll(() => readdir(destination)).toEqual(['pasted-image.png'])
      await row(folderName).focus()
      await page.keyboard.press(`${chord}+Shift+z`)
      await expect(row('pasted-image copy.png')).toHaveAttribute('data-selected', 'true')
      expect(await readFile(path.join(destination, 'pasted-image copy.png'))).toEqual(expected)
      await page.reload()
      await expect.poll(() => readdir(staging)).toEqual([])
      await testInfo.attach('pasted-image.png', { body: expected, contentType: 'image/png' })
      await testInfo.attach('paired-image-paste.json', {
        body: JSON.stringify(
          {
            transport: 'paired runtime over loopback; separate processes',
            platform: process.platform,
            clipboard: 'controlled reads in client; system clipboard untouched',
            hostPid: host.app.process().pid,
            clientPid: app.process().pid,
            sha256: createHash('sha256').update(expected).digest('hex'),
            commits: commits.map(({ source, destination: target }) => ({
              source,
              destination: target
            })),
            clientStagingEmpty: true,
            hostUploadTempsEmpty: true
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
    } finally {
      await clipboard.evaluate((probe) => {
        probe.restore()
      })
      await hostWrites.evaluate((probe) => {
        probe.restore()
      })
      await clipboard.dispose()
      await hostWrites.dispose()
    }
  } finally {
    try {
      await client?.dispose()
    } finally {
      await host.dispose()
    }
  }
})
