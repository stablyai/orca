import { execSync } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { test as base, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const fakeGhDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-fake-gh-'))
const fakeGhBody = `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(' ')
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('github.com\\n  ✓ Logged in to github.com account e2e (GITHUB_TOKEN)')
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'user') {
  console.log(JSON.stringify({ login: 'e2e' }))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('rate_limit')) {
  console.log(JSON.stringify({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 0 }, search: { limit: 30, remaining: 30, reset: 0 } } }))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'list') {
  console.log('[]')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  console.log('[]')
  process.exit(0)
}
if (args[0] === 'api' && (args[1] === 'graphql' || joined.includes('repos/acme/repo/issues/5388') || joined.includes('repos/acme/repo/pulls/5388'))) {
  setTimeout(() => {}, 60_000)
  return
}
console.error('fake gh: unhandled ' + joined)
process.exit(1)
`

const fakeGhPath = path.join(fakeGhDir, process.platform === 'win32' ? 'gh.cmd' : 'gh')
if (process.platform === 'win32') {
  writeFileSync(fakeGhPath, '@echo off\nnode "%~dp0\\fake-gh.js" %*\n')
  writeFileSync(path.join(fakeGhDir, 'fake-gh.js'), fakeGhBody)
} else {
  writeFileSync(fakeGhPath, fakeGhBody)
  chmodSync(fakeGhPath, 0o755)
}

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeGhDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_GH_EXEC_TIMEOUT_MS: '1000'
    },
    { option: true }
  ]
})

test.afterAll(() => {
  rmSync(fakeGhDir, { recursive: true, force: true })
})

function configureGitHubRemote(repoPath: string): void {
  try {
    execSync('git remote remove origin', { cwd: repoPath, stdio: 'ignore' })
  } catch {
    // Missing origin is fine for the disposable E2E repo.
  }
  try {
    execSync('git remote remove upstream', { cwd: repoPath, stdio: 'ignore' })
  } catch {
    // Missing upstream is fine for the disposable E2E repo.
  }
  execSync('git remote add origin https://github.com/acme/repo.git', {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execSync('git remote add upstream https://github.com/acme/repo.git', {
    cwd: repoPath,
    stdio: 'pipe'
  })
}

test('GitHub Tasks drawer recovers when gh stalls on issue details', async ({
  orcaPage,
  testRepoPath
}) => {
  configureGitHubRemote(testRepoPath)
  await waitForSessionReady(orcaPage)

  const { repoId } = await orcaPage.evaluate((repoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const repo = store.getState().repos.find((candidate) => candidate.path === repoPath)
    if (!repo) {
      throw new Error(`Expected repo to be loaded: ${repoPath}`)
    }
    const item = {
      id: 'issue-5388',
      type: 'issue',
      number: 5388,
      title: 'Issue detail fetch that hangs in gh',
      state: 'open',
      url: 'https://github.com/acme/repo/issues/5388',
      labels: [],
      updatedAt: '2026-06-15T20:00:00.000Z',
      author: 'octocat',
      repoId: repo.id
    }
    store.getState().openTaskPage({ taskSource: 'github', openGitHubWorkItem: item })
    return { repoId: repo.id }
  }, testRepoPath)

  const drawer = orcaPage
    .getByRole('dialog')
    .filter({ hasText: 'Issue detail fetch that hangs in gh' })
    .last()
  await expect(drawer).toBeVisible()

  // Why: this is the user-visible regression signal. Before ghExecFileAsync had
  // a default timeout, the drawer's pending details promise never settled and
  // the conversation pane stayed stuck in its loading shell. The main GitHub
  // details service degrades failed detail fetches to an empty shell, so the
  // stable visible proof is that the drawer becomes usable and stops spinning.
  await expect(drawer.getByText('No description provided.')).toBeVisible({ timeout: 5_000 })
  await expect(drawer.getByText('No comments yet.')).toBeVisible()
  await expect(drawer.locator('.animate-spin')).toHaveCount(0)

  expect(repoId).toBeTruthy()
})
