import { execFileSync } from 'node:child_process'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// The seeded project is displayed under its folder name; this is its name on the remote.
const REMOTE_NAME = 'lab-team/vault-registry'
const REMOTE_HOST = 'git.example.test'

function git(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

// Why hooks: the worker shares this repo, and the remote must exist before the app first probes it.
test.beforeEach(({ testRepoPath }) => {
  git(testRepoPath, ['remote', 'add', 'origin', `git@${REMOTE_HOST}:${REMOTE_NAME}.git`])
})

test.afterEach(({ testRepoPath }) => {
  try {
    git(testRepoPath, ['remote', 'remove', 'origin'])
  } catch {
    // The remote is already gone; a cleanup error must not hide the test's own result.
  }
})

test('finds a project and its workspaces by the name of their remote repository', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (repoPath) =>
            window.__store?.getState().repos.find((repo) => repo.path === repoPath)
              ?.gitRemoteIdentity?.canonicalKey ?? null,
          testRepoPath
        ),
      { timeout: 60_000, message: 'the window never learned the remote of the seeded repo' }
    )
    .toBe(`${REMOTE_HOST}/${REMOTE_NAME}`)

  const workspaceCount = await orcaPage.evaluate((repoPath) => {
    const state = window.__store?.getState()
    const repoId = state?.repos.find((repo) => repo.path === repoPath)?.id
    return state?.allWorktrees().filter((worktree) => worktree.repoId === repoId).length ?? 0
  }, testRepoPath)
  expect(workspaceCount).toBeGreaterThan(1)

  await orcaPage.evaluate(() => window.__store?.getState().openModal('worktree-palette'))
  // Why cmdk attributes: the palette's own labels are translated.
  await orcaPage.locator('[cmdk-input]').fill('vault-registry')
  try {
    // Every workspace of the repo, and the project itself.
    await expect(orcaPage.locator('[cmdk-item]', { hasText: REMOTE_NAME })).toHaveCount(
      workspaceCount + 1
    )
  } finally {
    await orcaPage.screenshot({ path: testInfo.outputPath('palette-remote-name.png') })
  }
})
