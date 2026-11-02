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

test('registration resolves nested and linked paths to one existing project', async ({
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
      const results = []
      for (const path of [repoPath, nestedPath]) {
        results.push(await window.api.repos.add({ path }))
      }
      if (results.some((result) => 'error' in result)) {
        throw new Error(JSON.stringify(results))
      }
      await window
        .__store!.getState()
        .fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
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

test('real WSL registration preserves literal paths and fences login output', async ({
  orcaPage
}, testInfo) => {
  const distro = process.env.ORCA_REAL_WSL_DISTRO
  test.skip(process.platform !== 'win32' || !distro, 'Requires a real Windows WSL distro')
  const { buildWslExecArgs, buildWslCapturedLoginShellCommand, quotePosixShell } =
    await import('../../src/shared/wsl-login-shell-command')
  const root = `/tmp/or60risk/run-${Date.now()}`
  const repoPath = `${root}/repo-$literal space`
  const uncPath = `\\\\wsl.localhost\\${distro}${repoPath.replaceAll('/', '\\')}`
  const setup = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, [
      '/bin/sh',
      '-c',
      `mkdir -p ${quotePosixShell(`${repoPath}/nested`)} && git init ${quotePosixShell(repoPath)}`
    ]),
    timeoutMs: 30_000
  })
  expect(setup.code, setup.stderr).toBe(0)
  try {
    const capture = buildWslCapturedLoginShellCommand(
      `git -C ${quotePosixShell(repoPath)} rev-parse --is-inside-work-tree`
    )
    const raw = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, [
        '/bin/sh',
        '-c',
        `printf 'OR60_LOGIN_NOISE\\n'; ${capture.command}`
      ]),
      timeoutMs: 30_000
    })
    expect(raw.code, raw.stderr).toBe(0)
    expect(raw.stdout).toContain('OR60_LOGIN_NOISE')
    expect(capture.readStdout(raw.stdout)).toBe('true\n')
    await waitForSessionReady(orcaPage)
    const added = await orcaPage.evaluate(
      async (path) => window.api.repos.add({ path }),
      `${uncPath}\\nested`
    )
    expect('repo' in added).toBe(true)
    expect('repo' in added && added.repo.path).toBe(uncPath)
    await orcaPage.screenshot({ path: testInfo.outputPath('wsl-project.png') })
  } finally {
    const cleanup = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, ['/bin/sh', '-c', `rm -rf ${quotePosixShell(root)}`]),
      timeoutMs: 30_000
    })
    expect(cleanup.code, cleanup.stderr).toBe(0)
  }
})
