import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  activateGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('switches local and origin branches from the status bar', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'branch-segment')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: fixture.worktreePath, encoding: 'utf8' }).trim()
  const currentBranch = (): string => git('branch', '--show-current')
  const start = currentBranch()
  git('branch', 'segment-local')
  const origin = testInfo.outputPath('origin.git')
  execFileSync('git', ['clone', '-q', '--bare', testRepoPath, origin])
  execFileSync('git', ['branch', 'segment-remote', 'main'], { cwd: origin })
  git('remote', 'add', 'origin', origin)
  git('fetch', '-q', 'origin')

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)

  const trigger = orcaPage.getByRole('button', { name: /^Switch branch, current branch/ })
  await expect(trigger).toContainText(start, { timeout: 15_000 })
  await trigger.click()

  const search = orcaPage.getByPlaceholder('Search branches')
  await expect(search).toBeFocused()
  const localRow = orcaPage.getByRole('option', { name: 'segment-local', exact: true })
  await expect(localRow).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('branch-menu-open.png') })
  await localRow.click()
  await expect.poll(currentBranch).toBe('segment-local')
  await expect(trigger).toContainText('segment-local')
  await expect(search).toHaveCount(0)

  await trigger.click()
  await orcaPage.getByPlaceholder('Search branches').fill('segment-remote')
  await orcaPage.getByRole('option', { name: 'origin/segment-remote', exact: true }).click()
  await expect.poll(currentBranch).toBe('segment-remote')
  expect(git('rev-parse', '--abbrev-ref', 'segment-remote@{upstream}')).toBe(
    'origin/segment-remote'
  )
  await expect(trigger).toContainText('segment-remote')

  // The host refuses a switch over uncommitted work, and the file must survive it.
  const file = path.join(fixture.worktreePath, 'segment-uncommitted.txt')
  writeFileSync(file, 'uncommitted\n')
  await trigger.click()
  await orcaPage.getByPlaceholder('Search branches').fill('segment-local')
  await orcaPage.getByRole('option', { name: 'segment-local', exact: true }).click()
  await expect(orcaPage.getByText(/Commit or discard/)).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('branch-switch-refused.png') })
  expect(currentBranch()).toBe('segment-remote')
  expect(readFileSync(file, 'utf8')).toBe('uncommitted\n')

  // The fixture's other worktree holds its branch: the row opens that workspace, not a checkout.
  await orcaPage.getByPlaceholder('Search branches').fill('e2e-secondary')
  const worktreeRow = orcaPage
    .getByRole('listbox', { name: 'Suggestions' })
    .getByRole('option', { name: /e2e-secondary/ })
  await expect(worktreeRow).toHaveCount(1)
  await orcaPage.screenshot({ path: testInfo.outputPath('branch-menu-worktrees.png') })
  await worktreeRow.click()
  await expect(trigger).toContainText('e2e-secondary')
  expect(currentBranch()).toBe('segment-remote')
})
