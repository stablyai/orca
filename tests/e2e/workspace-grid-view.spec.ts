import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  getStoreState,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

function gridViewCell(page: Page, worktreeId: string) {
  return page.locator(`[data-workspace-grid-view-cell="${worktreeId}"]`)
}

async function gridViewMembers(page: Page): Promise<string[]> {
  return getStoreState<string[]>(page, 'workspaceGridViewMemberIds')
}

/** A one-commit git repo outside the seeded test repo, so it lands in Orca as a separate project. */
async function createGitRepo(): Promise<string> {
  // The app lists worktrees by real path; macOS's temp dir is behind a symlink.
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-grid-view-project-')))
  writeFileSync(path.join(repoPath, 'README.md'), 'second project\n')
  const commit = ['-c', 'user.name=Grid View', '-c', 'user.email=grid-view@example.invalid']
  for (const args of [
    ['init', '-q'],
    ['add', 'README.md'],
    [...commit, 'commit', '-q', '-m', 'init']
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: repoPath, timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
  }
  return repoPath
}

async function addRepoWorktree(page: Page, repoPath: string): Promise<[string, string]> {
  const repoId = await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
  let worktreeId: string | undefined
  await expect
    .poll(
      async () => {
        worktreeId = (await getAllWorktreeIds(page)).find((id) => id.startsWith(`${repoId}::`))
        return worktreeId
      },
      { timeout: 30_000, message: 'the added project never listed its worktree' }
    )
    .toBeTruthy()
  if (!worktreeId) {
    throw new Error('the added project never listed its worktree')
  }
  return [repoId, worktreeId]
}

test('shows two workspaces side by side and moves focus between them', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const originalId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const otherId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== originalId)
  expect(otherId, 'the seeded repo provides a secondary worktree').toBeTruthy()
  if (!otherId) {
    return
  }
  await orcaPage.screenshot({ path: test.info().outputPath('single-workspace.png') })

  await orcaPage
    .locator(`[role="option"][data-worktree-id="${otherId}"]`)
    .click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Add to Grid View', exact: true }).click()

  await expect.poll(() => gridViewMembers(orcaPage)).toEqual([originalId, otherId])
  expect(await getActiveWorktreeId(orcaPage)).toBe(originalId)
  await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(2)

  // The secondary worktree was never opened, so its cell offers to open it in place.
  await gridViewCell(orcaPage, otherId).getByRole('button', { name: 'Open Workspace' }).click()
  await expect.poll(() => getActiveWorktreeId(orcaPage), { timeout: 20_000 }).toBe(otherId)
  await expect(gridViewCell(orcaPage, otherId).locator('[data-current="true"]')).toBeVisible()
  await expect(gridViewCell(orcaPage, originalId).locator('[data-current="true"]')).toHaveCount(0)

  // Clicking anywhere in the other cell hands focus back without leaving the grid view.
  await gridViewCell(orcaPage, originalId).locator('[data-workspace-grid-view-cell-header]').click()
  await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(originalId)
  await expect(
    orcaPage.locator(`[role="option"][data-worktree-id="${originalId}"]`)
  ).toHaveAttribute('aria-current', 'page')
  await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(2)
  await orcaPage.screenshot({ path: test.info().outputPath('workspace-grid-view.png') })

  await gridViewCell(orcaPage, otherId)
    .getByRole('button', { name: 'Remove from Grid View' })
    .click()
  await expect.poll(() => gridViewMembers(orcaPage)).toEqual([])
  expect(await getActiveWorktreeId(orcaPage)).toBe(originalId)
  await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(0)
})

test('shows workspaces from different projects side by side', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const firstWorktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  // Why from the id: activeRepoId stays null until a navigation stamps it.
  const firstRepoId = firstWorktreeId.split('::')[0]
  const repoPath = await createGitRepo()
  try {
    const [secondRepoId, secondWorktreeId] = await addRepoWorktree(orcaPage, repoPath)
    expect(secondRepoId).not.toBe(firstRepoId)

    await orcaPage
      .locator(`[role="option"][data-worktree-id="${secondWorktreeId}"]`)
      .click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Add to Grid View', exact: true }).click()
    await expect.poll(() => gridViewMembers(orcaPage)).toEqual([firstWorktreeId, secondWorktreeId])
    await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(2)
    // Each header names its own project, so same-named branches stay distinguishable.
    await expect(
      gridViewCell(orcaPage, secondWorktreeId).locator('[data-workspace-grid-view-cell-header]')
    ).toContainText(path.basename(repoPath))

    await gridViewCell(orcaPage, secondWorktreeId)
      .getByRole('button', { name: 'Open Workspace' })
      .click()
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), { timeout: 20_000 })
      .toBe(secondWorktreeId)
    await expect.poll(() => getStoreState<string>(orcaPage, 'activeRepoId')).toBe(secondRepoId)
    await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(2)

    await gridViewCell(orcaPage, firstWorktreeId)
      .locator('[data-workspace-grid-view-cell-header]')
      .click()
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(firstWorktreeId)
    await expect.poll(() => getStoreState<string>(orcaPage, 'activeRepoId')).toBe(firstRepoId)
    await expect(orcaPage.locator('[data-workspace-grid-view-cell]')).toHaveCount(2)
    await orcaPage.screenshot({ path: test.info().outputPath('cross-project-grid-view.png') })
  } finally {
    rmSync(repoPath, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
  }
})
