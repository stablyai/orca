import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []

async function createCloneFixture(): Promise<{
  sourcePath: string
  destinationParent: string
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-clone-'))
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
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-linked-'))
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

    await orcaPage
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
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
              cloneRepoVisibility: repo.externalWorktreeVisibility,
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
        cloneRepoVisibility: 'show',
        defaultCheckoutLooksCloned: true,
        oldSetupModalOpen: false
      })
  })

  test('reveals sibling git worktrees before opening the default checkout', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createLinkedWorktreeFixture()

    await orcaPage.evaluate((folderPath) => {
      window.__store?.getState().openModal('confirm-add-project-from-folder', { folderPath })
    }, fixture.mainPath)
    const addProjectDialog = orcaPage.getByRole('dialog', { name: /^Add Project$/i })
    await expect(addProjectDialog).toBeVisible()
    await addProjectDialog.getByRole('button', { name: /^Add Project$/ }).click()

    await expect(addProjectDialog).toBeHidden()
    await expect(orcaPage.getByRole('dialog', { name: /Repo added/i })).toBeHidden()
    await expect(orcaPage.getByText('Use existing worktrees')).toBeHidden()

    await expect
      .poll(
        () =>
          orcaPage.evaluate((mainPath) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const repo = state.repos.find((candidate) => candidate.path === mainPath)
            if (!repo) {
              return null
            }
            const worktrees = state.worktreesByRepo[repo.id] ?? []
            const defaultCheckout = worktrees.find((worktree) => worktree.isMainWorktree)
            return {
              activeCheckoutIsDefault: state.activeWorktreeId === defaultCheckout?.id,
              linkedRepoVisibility: repo.externalWorktreeVisibility,
              visibleBranches: worktrees.map((worktree) => worktree.branch).sort(),
              visibleCount: worktrees.length
            }
          }, fixture.mainPath),
        {
          timeout: 30_000,
          message: 'linked worktrees were not revealed before opening the default checkout'
        }
      )
      .toEqual({
        activeCheckoutIsDefault: true,
        linkedRepoVisibility: 'show',
        visibleBranches: ['refs/heads/feature', 'refs/heads/main'],
        visibleCount: 2
      })
  })
})
