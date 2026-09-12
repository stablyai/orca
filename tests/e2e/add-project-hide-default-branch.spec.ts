/**
 * Adding a project while "Hide default branch" is on must leave the filter alone
 * and still land the project in the sidebar as a header — its only row is the
 * hidden default checkout — instead of silently switching the filter off.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

const tempRoots: string[] = []

async function createMainOnlyRepoFixture(): Promise<string> {
  // Why: realpathSync so the path matches the store's repo.path on macOS, where
  // os.tmpdir() symlinks to /private/var and the app canonicalizes repo.path.
  const rootPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-hidden-default-'))
  )
  tempRoots.push(rootPath)

  const repoPath = path.join(rootPath, 'hidden-default-source')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), '# Hidden default source\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'pipe' })
  return repoPath
}

test.describe('Add project with Hide default branch on', () => {
  test('keeps the filter on and shows the project header without opening the checkout', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    // Why: afterEach runs before the electronApp fixture tears down, so the repo
    // could still be watched; on Windows that surfaces as EPERM and masks the result.
    registerPostElectronShutdownCleanup(async () => {
      for (const root of tempRoots.splice(0)) {
        await rm(root, { recursive: true, force: true, maxRetries: 5 })
      }
    })
    await waitForSessionReady(orcaPage)
    // Why: the dialog locators below assert English copy; pin the UI language so
    // the spec also passes on machines whose OS locale picks another catalog.
    await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.uiLanguage ?? null))
      .toBe('en')
    const repoPath = await createMainOnlyRepoFixture()

    // Poll rather than set once: hydration can land after the seed and reset the filters.
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const state = window.__store?.getState()
          state?.setSidebarOpen(true)
          state?.setGroupBy('repo')
          state?.setShowSleepingWorkspaces(true)
          state?.setShowActiveOnly(false)
          state?.setFilterRepoIds([])
          state?.setHideDefaultBranchWorkspace(true)
          return {
            groupBy: state?.groupBy ?? null,
            hideDefaultBranchWorkspace: state?.hideDefaultBranchWorkspace ?? null
          }
        })
      )
      .toEqual({ groupBy: 'repo', hideDefaultBranchWorkspace: true })

    await orcaPage.evaluate((folderPath) => {
      window.__store?.getState().openModal('confirm-add-project-from-folder', { folderPath })
    }, repoPath)
    const addProjectDialog = orcaPage.getByRole('dialog', { name: /^Add Project$/i })
    await expect(addProjectDialog).toBeVisible()
    await addProjectDialog.getByRole('button', { name: /^Add Project$/ }).click()
    await expect(addProjectDialog).toBeHidden()

    const readAddedProject = () =>
      orcaPage.evaluate((mainPath) => {
        const state = window.__store?.getState()
        const repo = state?.repos.find((candidate) => candidate.path === mainPath)
        if (!repo) {
          return null
        }
        const defaultCheckout = (state?.worktreesByRepo[repo.id] ?? []).find(
          (worktree) => worktree.isMainWorktree
        )
        return defaultCheckout ? { repoId: repo.id, defaultCheckoutId: defaultCheckout.id } : null
      }, repoPath)
    await expect
      .poll(readAddedProject, {
        timeout: 30_000,
        message: 'added repo default checkout was not loaded'
      })
      .not.toBeNull()
    const added = await readAddedProject()
    if (!added) {
      throw new Error('added repo default checkout disappeared after loading')
    }
    const { repoId, defaultCheckoutId } = added

    // The project lands as a header; its only row (the default checkout) stays hidden.
    const projectHeader = orcaPage.locator(`[data-repo-header-id="${repoId}"]`).first()
    await expect(projectHeader).toBeVisible()
    await expect(projectHeader).toContainText(path.basename(repoPath))
    await expect(worktreeRow(orcaPage, defaultCheckoutId)).toHaveCount(0)

    // The filter the user chose is untouched and the hidden checkout was not activated.
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ repoId, defaultCheckoutId }) => {
            const state = window.__store?.getState()
            return {
              activeRepoIsAdded: state?.activeRepoId === repoId,
              activeWorktreeIsHiddenCheckout: state?.activeWorktreeId === defaultCheckoutId,
              hideDefaultBranchWorkspace: state?.hideDefaultBranchWorkspace ?? null
            }
          },
          { repoId, defaultCheckoutId }
        )
      )
      .toEqual({
        activeRepoIsAdded: true,
        activeWorktreeIsHiddenCheckout: false,
        hideDefaultBranchWorkspace: true
      })
  })
})
