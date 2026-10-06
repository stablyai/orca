import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import { installLinkedIssueFakeGh } from './helpers/linked-issue-fake-gh'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const fakeGhDirectory = installLinkedIssueFakeGh()
const test = base.extend({
  launchEnv: [
    { PATH: `${fakeGhDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
    { option: true }
  ]
})

test.beforeAll(({ testRepoPath }) => {
  for (const [name, owner] of [
    ['origin', 'fork-owner'],
    ['upstream', 'upstream-owner']
  ]) {
    const remotes = execFileSync('git', ['remote'], { cwd: testRepoPath, encoding: 'utf8' })
    execFileSync(
      'git',
      [
        'remote',
        remotes.split(/\r?\n/).includes(name) ? 'set-url' : 'add',
        name,
        `https://github.com/${owner}/widgets.git`
      ],
      { cwd: testRepoPath }
    )
  }
})

test.afterAll(() => {
  rmSync(fakeGhDirectory, { recursive: true, force: true })
})

test('sidebar issue hover keeps each linked repository after selector changes', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const state = store.getState()
    const repo = state.repos[0]
    const worktrees = state.worktreesByRepo[repo.id]
    for (const [index, owner] of ['fork-owner', 'upstream-owner'].entries()) {
      const worktree = worktrees[index]
      await state.updateWorktreeMeta(worktree.id, {
        linkedIssue: 247,
        linkedWorkItem: {
          provider: 'github',
          type: 'issue',
          number: 247,
          title: index === 0 ? 'Origin hover issue' : 'Upstream hover issue',
          url: `https://github.com/${owner}/widgets/issues/247`,
          repoId: repo.id
        }
      })
    }
    await state.updateRepo(repo.id, { issueSourcePreference: 'origin' })
    state.setHideDefaultBranchWorkspace(false)
    state.setShowSleepingWorkspaces(true)
    state.setSidebarOpen(true)
    store.setState({
      repos: [{ ...repo, issueSourcePreference: 'origin' }],
      worktreeCardProperties: ['issue'],
      issueCache: {},
      collapsedGroups: new Set(),
      filterRepoIds: [],
      settings: { ...state.settings, experimentalNewWorktreeCardStyle: false }
    })
  })

  const badges = orcaPage.getByLabel('Workspace metadata', { exact: true })
  await expect(badges).toHaveCount(2)
  await badges.nth(0).hover()
  await expect(orcaPage.getByText('Origin hover issue', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('fork-label', { exact: true })).toBeVisible()
  const forkLink = orcaPage.getByRole('link', { name: 'View on GitHub', exact: true })
  await expect(forkLink).toHaveAttribute('href', 'https://github.com/fork-owner/widgets/issues/247')
  await orcaPage.screenshot({ path: testInfo.outputPath('origin-hover.png') })
  await testInfo.attach('Origin issue hover', {
    path: testInfo.outputPath('origin-hover.png'),
    contentType: 'image/png'
  })

  await orcaPage.mouse.move(800, 600)
  await badges.nth(1).hover()
  await expect(orcaPage.getByText('Upstream hover issue', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('upstream-label', { exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('link', { name: 'View on GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/upstream-owner/widgets/issues/247'
  )

  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const repo = store.getState().repos[0]
    await store.getState().updateRepo(repo.id, { issueSourcePreference: 'upstream' })
    store.setState({
      repos: [{ ...repo, issueSourcePreference: 'upstream' }],
      issueCache: {}
    })
    for (const worktree of store.getState().worktreesByRepo[repo.id]) {
      store.getState().refreshGitHubForWorktree(worktree.id)
    }
  })
  await orcaPage.mouse.move(800, 600)
  await badges.nth(0).hover()
  await expect(orcaPage.getByText('Origin hover issue', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('fork-label', { exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('link', { name: 'View on GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/fork-owner/widgets/issues/247'
  )
  await orcaPage.mouse.move(800, 600)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    store.setState({
      worktreeCardProperties: [],
      issueCache: {},
      settings: { ...store.getState().settings, experimentalNewWorktreeCardStyle: true }
    })
  })
  await orcaPage.getByRole('option').first().hover()
  const hoverCard = orcaPage.locator('[data-slot="hover-card-content"]')
  await expect(hoverCard.getByText('Origin hover issue', { exact: true }).last()).toBeVisible()
  await expect(hoverCard.getByText('fork-label', { exact: true })).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
