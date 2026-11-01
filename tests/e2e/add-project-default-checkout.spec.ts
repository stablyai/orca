import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []

async function createCloneFixture(): Promise<{
  sourcePath: string
  destinationParent: string
}> {
  // Canonicalize macOS /var → /private/var like git does when registering repo.path.
  const rootPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-clone-'))
  )
  tempRoots.push(rootPath)

  const sourcePath = path.join(rootPath, 'default-checkout-source')
  const destinationParent = path.join(rootPath, 'clones')

  mkdirSync(sourcePath, { recursive: true })
  mkdirSync(destinationParent, { recursive: true })
  execFileSync('git', ['init'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: sourcePath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: sourcePath, stdio: 'pipe' })
  writeFileSync(path.join(sourcePath, 'README.md'), '# Default checkout source\n')
  execFileSync('git', ['add', 'README.md'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: sourcePath, stdio: 'pipe' })

  return { sourcePath, destinationParent }
}

async function createLinkedWorktreeFixture(): Promise<{
  mainPath: string
  siblingPath: string
}> {
  // Canonicalize the main checkout path like git does on macOS /var symlinks.
  const rootPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-linked-'))
  )
  tempRoots.push(rootPath)

  const mainPath = path.join(rootPath, 'linked-source')
  const siblingPath = path.join(rootPath, 'linked-feature')

  mkdirSync(mainPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: mainPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: mainPath, stdio: 'pipe' })
  writeFileSync(path.join(mainPath, 'README.md'), '# Linked source\n')
  execFileSync('git', ['add', 'README.md'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['worktree', 'add', '-b', 'feature', siblingPath], {
    cwd: mainPath,
    stdio: 'pipe'
  })

  return { mainPath, siblingPath }
}

async function addProjectFromFolder(page: Page, folderPath: string): Promise<void> {
  await page.evaluate((selectedPath) => {
    window.__store?.getState().openModal('confirm-add-project-from-folder', {
      folderPath: selectedPath
    })
  }, folderPath)
  const addProjectDialog = page.getByRole('dialog', { name: /^Add Project$/i })
  await expect(addProjectDialog).toBeVisible()
  await addProjectDialog.getByRole('button', { name: /^Add Project$/ }).click()
  await expect(addProjectDialog).toBeHidden()
  await expect(page.getByRole('dialog', { name: /Repo added/i })).toBeHidden()
  await expect(page.getByText('Use existing worktrees')).toBeHidden()
}

async function readOpenedProject(page: Page, repoPath: string) {
  return page.evaluate((path) => {
    const state = window.__store?.getState()
    const repo = state?.repos.find((candidate) => candidate.path === path)
    if (!state || !repo) {
      return null
    }
    const worktrees = state.worktreesByRepo[repo.id] ?? []
    return {
      activePath: worktrees.find((worktree) => worktree.id === state.activeWorktreeId)?.path,
      repoVisibility: repo.externalWorktreeVisibility,
      visibilityPromptResolved:
        typeof repo.externalWorktreeVisibilityPromptDismissedAt === 'number',
      visibleBranches: worktrees.map((worktree) => worktree.branch).sort()
    }
  }, repoPath)
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.describe('Add project default checkout', () => {
  test('clones a repo and opens the default checkout without the setup-choice modal', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createCloneFixture()

    await openSidebarProjectDialog(orcaPage)
    const addDialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(addDialog).toBeVisible()
    await addDialog.getByRole('button', { name: /Clone from URL/i }).click()

    const cloneDialog = orcaPage.getByRole('dialog', { name: /Clone from URL/i })
    await expect(cloneDialog).toBeVisible()
    await cloneDialog.getByPlaceholder('https://github.com/user/repo.git').fill(fixture.sourcePath)
    await cloneDialog.getByPlaceholder('/path/to/destination').fill(fixture.destinationParent)
    await cloneDialog.getByRole('button', { name: /^Clone$/ }).click()

    await expect(orcaPage.getByRole('dialog', { name: /Repo added/i })).toBeHidden()
    await expect(orcaPage.getByText('Use existing worktrees')).toBeHidden()
    await expect(orcaPage.getByText('Create a new worktree')).toBeHidden()

    await expect
      .poll(
        () =>
          orcaPage.evaluate((cloneName) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const repo = state.repos.find((candidate) => candidate.displayName === cloneName)
            if (!repo) {
              return null
            }
            const worktrees = state.worktreesByRepo[repo.id] ?? []
            const defaultCheckout = worktrees.find((worktree) => worktree.isMainWorktree)
            const normalizedDefaultCheckoutPath = defaultCheckout?.path.replace(/\\/g, '/') ?? null
            return {
              activeCheckoutIsDefault: state.activeWorktreeId === defaultCheckout?.id,
              defaultCheckoutLooksCloned:
                normalizedDefaultCheckoutPath?.endsWith(`/clones/${cloneName}`) ?? false,
              oldSetupModalOpen: state.activeModal === 'project-added'
            }
          }, path.basename(fixture.sourcePath)),
        {
          timeout: 30_000,
          message: 'cloned repo default checkout was not opened'
        }
      )
      .toEqual({
        activeCheckoutIsDefault: true,
        defaultCheckoutLooksCloned: true,
        oldSetupModalOpen: false
      })
    await expect(
      orcaPage.locator('[data-worktree-sidebar] [role="option"][aria-current="page"]')
    ).toContainText('main')
  })

  test('keeps sibling git worktrees hidden behind a hint that opens the visibility dialog', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createLinkedWorktreeFixture()

    await addProjectFromFolder(orcaPage, fixture.mainPath)

    await expect
      .poll(() => readOpenedProject(orcaPage, fixture.mainPath), {
        timeout: 30_000,
        message: 'the default checkout did not open with its sibling hidden'
      })
      .toEqual({
        activePath: fixture.mainPath,
        repoVisibility: undefined,
        visibilityPromptResolved: true,
        visibleBranches: ['refs/heads/main']
      })

    const hint = orcaPage
      .locator('[data-worktree-sidebar]')
      .getByRole('button', { name: /^Review 1 hidden worktree in linked-source$/ })
    await expect(hint).toBeVisible()
    await hint.click()
    await expect(orcaPage.getByRole('dialog', { name: /Non-Orca worktrees/i })).toBeVisible()
  })

  test('opens the linked checkout picked in the folder dialog', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createLinkedWorktreeFixture()

    await addProjectFromFolder(orcaPage, fixture.siblingPath)

    await expect
      .poll(() => readOpenedProject(orcaPage, fixture.siblingPath), {
        timeout: 30_000,
        message: 'the picked linked checkout was not opened'
      })
      .toEqual({
        activePath: fixture.siblingPath,
        repoVisibility: undefined,
        visibilityPromptResolved: true,
        visibleBranches: ['refs/heads/feature']
      })
    await expect(
      orcaPage.locator('[data-worktree-sidebar] [role="option"][aria-current="page"]')
    ).toContainText('feature')
  })
})
