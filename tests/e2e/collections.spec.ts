import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

function createDisposableRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'orca-collections-e2e-repo-'))
  const worktreePath = `${repoPath}-billing`
  execFileSync('git', ['init'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'collections@test.local'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Collections Test'], { cwd: repoPath })
  writeFileSync(path.join(repoPath, 'README.md'), '# Collections E2E\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath })
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'billing-e2e'], {
    cwd: repoPath
  })
  return { repoPath, worktreePath }
}

test('collection lifecycle preserves worktrees and membership rules', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const disposable = createDisposableRepo()
  registerPostElectronShutdownCleanup(async () => {
    rmSync(disposable.worktreePath, { recursive: true, force: true })
    rmSync(disposable.repoPath, { recursive: true, force: true })
  })

  const secondRepoId = await orcaPage.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, disposable.repoPath)

  await expect
    .poll(() =>
      orcaPage.evaluate(async (repoId) => {
        const store = window.__store
        if (!store) {
          return 0
        }
        await store.getState().fetchRepos()
        await store.getState().updateRepo(repoId, { externalWorktreeVisibility: 'show' })
        await store.getState().fetchWorktrees(repoId)
        return store.getState().worktreesByRepo[repoId]?.length ?? 0
      }, secondRepoId)
    )
    .toBeGreaterThanOrEqual(2)

  const snapshot = await orcaPage.evaluate((repoId) => {
    const state = window.__store!.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat()
    const firstRepo = state.repos.find((repo) => repo.id !== repoId)!
    const secondRepo = state.repos.find((repo) => repo.id === repoId)!
    const firstFeature = state.worktreesByRepo[firstRepo.id].find(
      (worktree) => !worktree.isMainWorktree
    )!
    const secondFeature = state.worktreesByRepo[secondRepo.id].find(
      (worktree) => !worktree.isMainWorktree
    )!
    const main = allWorktrees.find((worktree) => worktree.isMainWorktree)!
    return {
      firstFeatureId: firstFeature.id,
      firstFeatureName: firstFeature.displayName,
      secondFeatureId: secondFeature.id,
      mainId: main.id
    }
  }, secondRepoId)

  const worktreeListBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: disposable.repoPath,
    encoding: 'utf8'
  })

  await orcaPage.getByRole('button', { name: /^Add Collection$/ }).click()
  const addDialog = orcaPage.getByRole('dialog', { name: /^Add Collection$/ })
  await addDialog.getByPlaceholder('Collection name').fill('Approve PRs')
  const newWorktreeRows = addDialog.locator('label').filter({ hasText: 'New worktree' })
  await expect(newWorktreeRows).toHaveCount(2)
  await newWorktreeRows.nth(0).click()
  await newWorktreeRows.nth(1).click()
  await addDialog.locator('label').filter({ hasText: snapshot.firstFeatureName }).click()
  await addDialog.getByRole('button', { name: /^Create$/ }).click()
  await expect(addDialog).toBeHidden()

  const approveHeader = orcaPage.locator('[data-collection-header-id]').filter({
    hasText: 'Approve PRs'
  })
  await expect(approveHeader).toBeVisible()
  const approveId = await approveHeader.getAttribute('data-collection-header-id')
  expect(approveId).toBeTruthy()
  // Why: create checked both "New worktree" rows, so the git list legitimately
  // grows here; every later collection operation must leave it untouched.
  await expect
    .poll(
      () =>
        execFileSync('git', ['worktree', 'list', '--porcelain'], {
          cwd: disposable.repoPath,
          encoding: 'utf8'
        }),
      { timeout: 30_000 }
    )
    .not.toBe(worktreeListBefore)
  const worktreeListAfterCreate = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: disposable.repoPath,
    encoding: 'utf8'
  })

  const normalSecondFeature = orcaPage
    .locator(`[role="option"][data-worktree-id=${JSON.stringify(snapshot.secondFeatureId)}]`)
    .last()
    .locator('[data-worktree-card-surface]')
  await normalSecondFeature.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Add to Collection' }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Collection…' }).click()
  const newCollectionDialog = orcaPage.getByRole('dialog', { name: /^New Collection$/ })
  await newCollectionDialog.getByRole('textbox').fill('Billing migration')
  await newCollectionDialog.getByRole('button', { name: /^Create$/ }).click()

  const billingHeader = orcaPage.locator('[data-collection-header-id]').filter({
    hasText: 'Billing migration'
  })
  await expect(billingHeader).toBeVisible()
  const billingId = await billingHeader.getAttribute('data-collection-header-id')
  expect(billingId).toBeTruthy()

  await normalSecondFeature.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Move to Collection' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Approve PRs' }).click()
  await expect
    .poll(() =>
      orcaPage.evaluate((worktreeId) => {
        const state = window.__store!.getState()
        return Object.values(state.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === worktreeId)?.collectionIds
      }, snapshot.secondFeatureId)
    )
    .toEqual([approveId])

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const cliShow = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.resolve('out/cli/index.js'),
        'worktree',
        'show',
        '--worktree',
        `id:${snapshot.secondFeatureId}`,
        '--json'
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir },
        encoding: 'utf8'
      }
    )
  ) as { result: { worktree: { collectionIds?: string[] } } }
  expect(cliShow.result.worktree.collectionIds).toEqual([approveId])

  await orcaPage.evaluate(
    async ({ worktreeId, collectionIds }) => {
      await window.__store!.getState().updateWorktreeMeta(worktreeId, { collectionIds })
    },
    { worktreeId: snapshot.mainId, collectionIds: [approveId!, billingId!] }
  )
  await expect
    .poll(() =>
      orcaPage.evaluate((worktreeId) => {
        const state = window.__store!.getState()
        return Object.values(state.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === worktreeId)
          ?.collectionIds?.toSorted()
      }, snapshot.mainId)
    )
    .toEqual([approveId, billingId].toSorted())

  await approveHeader.click()
  await expect(approveHeader).toHaveAttribute('aria-expanded', 'false')
  await approveHeader.click()
  await expect(approveHeader).toHaveAttribute('aria-expanded', 'true')

  await billingHeader.hover()
  await orcaPage
    .getByRole('button', { name: 'Collection actions for Billing migration', exact: true })
    .click()
  await orcaPage.getByRole('menuitem', { name: 'Rename collection' }).click()
  const renameDialog = orcaPage.getByRole('dialog', { name: /^Rename Collection$/ })
  await renameDialog.getByRole('textbox').fill('Billing migration QA')
  await renameDialog.getByRole('button', { name: /^Rename$/ }).click()
  await expect(
    orcaPage.locator('[data-collection-header-id]').filter({ hasText: 'Billing migration QA' })
  ).toBeVisible()

  const renamedHeader = orcaPage.locator('[data-collection-header-id]').filter({
    hasText: 'Billing migration QA'
  })
  await renamedHeader.hover()
  await orcaPage
    .getByRole('button', { name: 'Collection actions for Billing migration QA', exact: true })
    .click()
  await orcaPage.getByRole('menuitem', { name: 'Delete collection' }).click()
  const deleteDialog = orcaPage.getByRole('dialog', { name: /Delete “Billing migration QA”/ })
  await expect(deleteDialog).toContainText('Worktrees are not affected')
  await deleteDialog.getByRole('button', { name: /^Delete$/ }).click()
  await expect(renamedHeader).toHaveCount(0)

  expect(
    execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: disposable.repoPath,
      encoding: 'utf8'
    })
  ).toBe(worktreeListAfterCreate)
})
