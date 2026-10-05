import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import './helpers/runtime-types'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

async function openImage(
  page: Page,
  worktreeId: string,
  rootPath: string,
  name: string
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, filePath, name }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store is unavailable')
      }
      store.getState().openFile({
        filePath,
        relativePath: name,
        worktreeId,
        language: 'xml',
        mode: 'edit'
      })
    },
    { worktreeId, filePath: path.join(rootPath, name), name }
  )
}

async function expectImage(page: Page, name: string, width: number, height: number): Promise<void> {
  const image = page.getByRole('img', { name, exact: true }).first()
  await expect(image).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() =>
      image.evaluate((element) => {
        if (!(element instanceof HTMLImageElement)) {
          throw new Error('Image element missing')
        }
        return [element.naturalWidth, element.naturalHeight]
      })
    )
    .toEqual([width, height])
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
}

for (const workspace of ['git', 'folder'] as const) {
  test(`renders SVGs on a paired desktop in a ${workspace} workspace`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(120_000)
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="navy"/><text x="20" y="65" fill="white">SVG preview proof</text></svg>'
    await orcaPage.waitForFunction(
      () =>
        window.__store?.getState().workspaceSessionReady === true &&
        Boolean(window.__store.getState().activeWorktreeId)
    )
    if (workspace === 'folder') {
      const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-svg-folder-')))
      registerPostElectronShutdownCleanup(async () => rm(folder, { recursive: true, force: true }))
      await orcaPage.evaluate(async (folderPath) => {
        const store = window.__store
        if (!store || !(await store.getState().addNonGitFolder(folderPath))) {
          throw new Error('Folder workspace could not be added')
        }
      }, folder)
      await expect
        .poll(async () => (await getActiveWorktreeContext(orcaPage)).rootPath)
        .toBe(folder)
    }
    const host = await getActiveWorktreeContext(orcaPage)
    const testRepoPath = host.rootPath
    await writeFile(path.join(testRepoPath, 'preview.SVG'), svg)
    await writeFile(path.join(testRepoPath, 'broken.svg'), '<svg this is invalid')
    await openImage(orcaPage, host.worktreeId, host.rootPath, 'preview.SVG')
    await expectImage(orcaPage, 'preview.SVG', 240, 120)
    await orcaPage.screenshot({ path: '/tmp/orca-editor-svg-host-preview.png' })
    await openImage(orcaPage, host.worktreeId, host.rootPath, 'broken.svg')
    await expect(orcaPage.getByText('Failed to load file preview', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Loading preview...', { exact: true })).toHaveCount(0)
    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    let client: PairedElectronClient | null = null
    try {
      client = await launchPairedElectronClient(offer, testInfo, 'SVG preview audit')
      const page = client.page
      await expect
        .poll(
          () =>
            page.evaluate(
              (repoPath) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((entry) => entry.path === repoPath) ?? false,
              testRepoPath
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      const remote = await page.evaluate(
        ({ repoPath, environmentId }) => {
          const store = window.__store
          const worktree = store
            ?.getState()
            .allWorktrees()
            .find((entry) => entry.path === repoPath)
          if (!store || !worktree) {
            throw new Error('Paired worktree is unavailable')
          }
          store.getState().setActiveWorktree(worktree.id, `runtime:${environmentId}`)
          return { worktreeId: worktree.id, rootPath: worktree.path }
        },
        { repoPath: testRepoPath, environmentId: client.environmentId }
      )
      await openImage(page, remote.worktreeId, remote.rootPath, 'preview.SVG')
      await expect
        .poll(() =>
          page
            .locator('img[alt="preview.SVG"], .monaco-editor .view-lines[role="presentation"]')
            .count()
        )
        .toBeGreaterThan(0)
      await page.screenshot({ path: '/tmp/orca-editor-svg-paired-before-assert.png' })
      await expectImage(page, 'preview.SVG', 240, 120)
      await page.screenshot({ path: '/tmp/orca-editor-svg-paired-preview.png' })
      await openImage(page, remote.worktreeId, remote.rootPath, 'broken.svg')
      await expect(page.getByText('Failed to load file preview', { exact: true })).toBeVisible()
      await expect(page.getByText('Loading preview...', { exact: true })).toHaveCount(0)
    } finally {
      await client?.dispose()
    }
  })
}
