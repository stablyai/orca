import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { runProcess } from '@orca/process-host'

test.use({ seedTestRepo: false })

async function runFixtureGit(spec: Parameters<typeof runProcess>[0]): Promise<void> {
  const result = await runProcess(spec)
  expect(result.code, result.stderr).toBe(0)
}

test('concurrent registration keeps one identity, including nested and linked paths', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-registration-')))
  const repoPath = join(root, 'repo')
  const nestedPath = join(repoPath, 'nested')
  const linkedPath = join(root, 'linked')
  mkdirSync(nestedPath, { recursive: true })
  registerPostElectronShutdownCleanup(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  await runFixtureGit({ program: 'git', args: ['init', repoPath] })
  await runFixtureGit({
    program: 'git',
    args: [
      '-c',
      'user.name=E2E',
      '-c',
      'user.email=e2e@test.local',
      'commit',
      '--allow-empty',
      '-m',
      'fixture'
    ],
    cwd: repoPath
  })
  await runFixtureGit({
    program: 'git',
    args: ['worktree', 'add', '-b', 'linked', linkedPath],
    cwd: repoPath
  })
  await waitForSessionReady(orcaPage)
  const result = await orcaPage.evaluate(
    async ({ repoPath, nestedPath }) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          window.api.repos.add({ path: index % 2 ? nestedPath : repoPath })
        )
      )
      if (results.some((result) => 'error' in result)) {
        throw new Error(JSON.stringify(results))
      }
      await window.__store!.getState().fetchRepos()
      await window.__store!.getState().awaitLocalRepoCatalogSettlement()
      return {
        ids: results.map((result) => ('repo' in result ? result.repo.id : null)),
        persistedIds: (await window.api.repos.list()).map((repo) => repo.id)
      }
    },
    { repoPath, nestedPath }
  )
  expect(new Set(result.ids).size).toBe(1)
  expect(result.persistedIds).toEqual([result.ids[0]])
  // A repos:changed refresh can supersede the explicitly awaited catalog fetch.
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store!.getState().repos.map((repo) => repo.id)))
    .toEqual(result.persistedIds)
  const linked = await orcaPage.evaluate(async (path) => window.api.repos.add({ path }), linkedPath)
  expect('repo' in linked && linked.repo.id).toBe(result.ids[0])
  const missing = await orcaPage.evaluate(
    async (path) => window.api.repos.add({ path }),
    join(root, 'missing')
  )
  expect('error' in missing).toBe(true)
  expect(
    await orcaPage.evaluate(async () => (await window.api.repos.list()).map((repo) => repo.id))
  ).toEqual(result.persistedIds)
})
