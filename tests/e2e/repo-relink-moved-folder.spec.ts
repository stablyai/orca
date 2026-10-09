import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { runProcess } from '../../src/shared/child-process/run-process'

test.use({ seedTestRepo: false })

async function createCheckout(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true })
  writeFileSync(path.join(repoPath, 'README.md'), '# relink\n')
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'seed'
    ]
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: repoPath, timeoutMs: 10_000 })
    expect(result.code, result.stderr).toBe(0)
  }
}

/** Registers the checkout and names its main worktree, the metadata the relink must carry. */
async function registerNamedCheckout(
  page: Page,
  repoPath: string,
  displayName: string
): Promise<{ repoId: string; worktreeId: string }> {
  return page.evaluate(
    async ({ repoPath, displayName }) => {
      const store = window.__store!
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      await store.getState().awaitLocalRepoCatalogSettlement()
      await store.getState().fetchWorktrees(added.repo.id)
      const main = store
        .getState()
        .worktreesByRepo[added.repo.id]?.find((worktree) => worktree.isMainWorktree)
      if (!main) {
        throw new Error('main worktree not listed')
      }
      await window.api.worktrees.updateMeta({ worktreeId: main.id, updates: { displayName } })
      await store.getState().fetchWorktrees(added.repo.id)
      store.getState().setGroupBy('repo')
      store.getState().setHideDefaultBranchWorkspace(false)
      store.getState().setSidebarOpen(true)
      return { repoId: added.repo.id, worktreeId: main.id }
    },
    { repoPath, displayName }
  )
}

function worktreeRow(page: Page, worktreeId: string) {
  return page.locator(
    `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(worktreeId)}]`
  )
}

async function checkRepoPaths(page: Page): Promise<void> {
  // Focus checks are throttled; force one so the test does not wait out the TTL.
  await page.evaluate(() => window.__store!.getState().refreshRepoPathStatuses({ force: true }))
}

test.describe('relinking a moved repository', () => {
  test.skip(process.platform === 'win32', 'symlinked folders need elevated rights on Windows')

  test('follows a symlink left behind and keeps the worktree name', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-relink-moved-')))
    registerPostElectronShutdownCleanup(async () => {
      rmSync(root, { recursive: true, force: true })
    })
    const oldPath = path.join(root, 'projects', 'relink-app')
    const newPath = path.join(root, 'disk2', 'relink-app')
    await createCheckout(oldPath)
    const { repoId, worktreeId } = await registerNamedCheckout(orcaPage, oldPath, 'Kept name')
    await expect(worktreeRow(orcaPage, worktreeId)).toContainText('Kept name')

    mkdirSync(path.dirname(newPath), { recursive: true })
    renameSync(oldPath, newPath)
    symlinkSync(newPath, oldPath)
    await checkRepoPaths(orcaPage)

    const indicator = orcaPage.locator('[data-repo-path-status="moved"]')
    await expect(indicator).toBeVisible()
    await expect(indicator).toHaveAttribute('aria-label', /Repository moved/)
    await orcaPage.screenshot({ path: testInfo.outputPath('repo-relink-moved-indicator.png') })

    await indicator.click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Repository moved' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`Moved to ${newPath}. Update the location?`)
    await expect(dialog.getByRole('textbox')).toHaveValue(newPath)
    await orcaPage.screenshot({ path: testInfo.outputPath('repo-relink-moved-dialog.png') })

    await dialog.getByRole('button', { name: 'Update location' }).click()
    await expect(dialog).toBeHidden()
    await expect(orcaPage.getByText('Relinked relink-app')).toBeVisible()
    await expect(indicator).toHaveCount(0)
    const relinkedRow = worktreeRow(orcaPage, `${repoId}::${newPath}`)
    await expect(relinkedRow).toContainText('Kept name')
    await expect(worktreeRow(orcaPage, worktreeId)).toHaveCount(0)
    await orcaPage.screenshot({ path: testInfo.outputPath('repo-relink-after.png') })
  })

  test('locates a vanished folder and asks before an unconfirmed relink', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-relink-missing-')))
    registerPostElectronShutdownCleanup(async () => {
      rmSync(root, { recursive: true, force: true })
    })
    const oldPath = path.join(root, 'relink-gone')
    const newPath = path.join(root, 'archive', 'relink-gone')
    await createCheckout(oldPath)
    const { repoId } = await registerNamedCheckout(orcaPage, oldPath, 'Still named')

    mkdirSync(path.dirname(newPath), { recursive: true })
    renameSync(oldPath, newPath)
    await checkRepoPaths(orcaPage)

    const indicator = orcaPage.locator('[data-repo-path-status="missing"]')
    await expect(indicator).toBeVisible()
    await indicator.click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Repository folder not found' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill(newPath)
    await orcaPage.screenshot({ path: testInfo.outputPath('repo-relink-missing-dialog.png') })
    await dialog.getByRole('button', { name: 'Relink', exact: true }).click()

    // No remote and no linked worktree to compare: Orca must ask, not guess.
    await expect(dialog.getByRole('alert')).toContainText(
      'Orca cannot confirm this is the same repository'
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('repo-relink-unverified.png') })
    await dialog.getByRole('button', { name: 'Relink anyway' }).click()
    await expect(dialog).toBeHidden()
    await expect(worktreeRow(orcaPage, `${repoId}::${newPath}`)).toContainText('Still named')
  })
})
