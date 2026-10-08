import './github-actions-discovery-recovery'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import type { ActionsRunsQuery } from '../../src/shared/github/actions-types'

declare global {
  var __actionsTestQueries: ActionsRunsQuery[] | undefined
}
const repository = { owner: 'acme', repo: 'widgets', host: 'github.enterprise.test' }
const run = {
  id: 900,
  workflowId: 7,
  runNumber: 42,
  runAttempt: 2,
  workflowPath: '.github/workflows/build.yml@refs/heads/main',
  name: 'Build and deploy a very long workflow name',
  displayTitle: 'Repository workflow without a pull request',
  headBranch: 'main',
  headSha: 'abcdef1234567890',
  event: 'push',
  actor: 'fixture-bot',
  status: 'completed',
  conclusion: 'failure',
  htmlUrl: 'https://github.enterprise.test/acme/widgets/actions/runs/900',
  createdAt: '2026-09-30T01:00:00Z',
  updatedAt: '2026-09-30T01:02:00Z',
  runStartedAt: '2026-09-30T01:00:01Z'
}
const jobs = [
  {
    id: 10,
    name: 'Failed build',
    status: 'completed',
    conclusion: 'failure',
    logTail: 'FAIL: synthetic build excerpt',
    steps: [
      {
        name: 'Compile',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null
      }
    ]
  },
  {
    id: 11,
    name: 'Successful sibling',
    status: 'completed',
    conclusion: 'success',
    logTail: null,
    steps: [
      {
        name: 'Test',
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null
      }
    ]
  },
  { id: 12, name: 'Pending sibling', status: 'queued', conclusion: null, logTail: null, steps: [] }
].map((job) => ({
  ...job,
  startedAt: null,
  completedAt: null,
  url: `https://github.enterprise.test/acme/widgets/actions/runs/900/job/${job.id}`
}))

test('repository Actions filters, paging and all-job details stay hidden in light and dark themes', async ({
  orcaPage: page,
  electronApp
}) => {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await electronApp.evaluate(
    ({ ipcMain }, fixture) => {
      globalThis.__actionsTestQueries = []
      let workflowPageTwoFailed = false
      for (const name of [
        'gh:repoSlug',
        'gh:actionsRuns',
        'gh:actionsWorkflows',
        'gh:actionsRunDetails'
      ]) {
        ipcMain.removeHandler(name)
      }
      ipcMain.handle('gh:repoSlug', async () => fixture.repository)
      ipcMain.handle('gh:actionsRuns', async (_event, args) => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        globalThis.__actionsTestQueries?.push(args)
        const page = args.page ?? 1
        return {
          repository: fixture.repository,
          page,
          perPage: 50,
          totalCount: 51,
          hasNextPage: page === 1,
          limitReached: false,
          items: [
            {
              ...fixture.run,
              id: 899 + page,
              displayTitle: page === 1 ? fixture.run.displayTitle : 'Older workflow run'
            }
          ]
        }
      })
      ipcMain.handle('gh:actionsWorkflows', async (_event, args) => {
        if (args.page === 2 && !workflowPageTwoFailed) {
          workflowPageTwoFailed = true
          throw new Error('Workflow options temporarily unavailable')
        }
        return {
          repository: fixture.repository,
          page: args.page ?? 1,
          perPage: 100,
          totalCount: 101,
          hasNextPage: args.page !== 2,
          limitReached: false,
          items: [
            {
              id: args.page === 2 ? 8 : 7,
              name: args.page === 2 ? 'Deploy' : fixture.run.name,
              path: '.github/workflows/build.yml',
              state: 'active'
            }
          ]
        }
      })
      ipcMain.handle('gh:actionsRunDetails', async (_event, args) => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        return {
          name: fixture.run.displayTitle,
          status: 'completed',
          conclusion: 'failure',
          url: fixture.run.htmlUrl,
          detailsUrl: fixture.run.htmlUrl,
          startedAt: fixture.run.runStartedAt,
          completedAt: null,
          title: null,
          summary: null,
          text: null,
          annotations: [],
          jobs:
            args.jobsPage === 2
              ? [{ ...fixture.jobs[1], id: 13, name: 'Additional job' }]
              : fixture.jobs,
          actions: {
            repository: fixture.repository,
            run: fixture.run,
            jobsPage: args.jobsPage ?? 1,
            hasNextPage: args.jobsPage !== 2,
            limitReached: false,
            totalJobs: 101,
            jobsError: null,
            logWarnings: []
          }
        }
      })
    },
    { repository, run, jobs }
  )
  await page.waitForTimeout(8000)
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Missing fixture store')
    }
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.enterprise.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'https://github.enterprise.test/acme/widgets.git'
        }
      }))
    }))
    store.getState().openTaskPage({ taskSource: 'github' })
  })
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Issues', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'PRs', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible()
  const row = page.getByRole('button', { name: /Repository workflow without a pull request/ })
  await expect(row).toBeVisible()
  const calls = await electronApp.evaluate(() => globalThis.__actionsTestQueries?.length ?? 0)
  await page.evaluate(() =>
    window.__store?.setState((state) => ({
      worktreesByRepo: Object.fromEntries(
        Object.entries(state.worktreesByRepo).map(([repoId, worktrees]) => [
          repoId,
          worktrees.map((worktree) => ({ ...worktree, lastActivityAt: Date.now() }))
        ])
      )
    }))
  )
  await page.waitForTimeout(400)
  expect(await electronApp.evaluate(() => globalThis.__actionsTestQueries?.length ?? 0)).toBe(calls)
  await page.getByRole('textbox', { name: 'Branch', exact: true }).fill('topic & release')
  await page.waitForTimeout(250)
  expect(await electronApp.evaluate(() => globalThis.__actionsTestQueries?.length ?? 0)).toBe(calls)
  await page.getByRole('textbox', { name: 'Branch', exact: true }).press('Enter')
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__actionsTestQueries?.at(-1)?.branch))
    .toBe('topic & release')
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(page.getByRole('button', { name: /Older workflow run/ })).toBeVisible()
  await page.getByRole('button', { name: 'Previous page', exact: true }).click()
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: 'Load more workflows', exact: true }).click()
  await expect(page.getByText('Workflow options temporarily unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Load more workflows', exact: true }).click()
  await expect(page.getByText('Workflow options temporarily unavailable')).toHaveCount(0)
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('option', { name: 'Deploy', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__actionsTestQueries?.at(-1)?.workflowId))
    .toBe(8)
  await page.getByRole('combobox', { name: 'Status', exact: true }).click()
  await page.getByRole('option', { name: 'Failure', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__actionsTestQueries?.at(-1)?.status))
    .toBe('failure')
  const screenshotDir =
    process.env.ORCA_ACTIONS_SCREENSHOT_DIR ??
    path.join(process.cwd(), 'test-results', 'github-actions')
  mkdirSync(screenshotDir, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing store')
      }
      await store.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await expect(row).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
    await expect(page.getByRole('status').filter({ hasText: 'Loading runs' })).toHaveCount(0)
    await page.screenshot({ path: path.join(screenshotDir, `actions-list-${theme}.png`) })
  }
  await row.click()
  await expect(page.getByText('Successful sibling', { exact: true })).toBeVisible()
  await expect(page.getByText('Pending sibling', { exact: true })).toBeVisible()
  await expect(page.getByText('FAIL: synthetic build excerpt', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open job on GitHub', exact: true })).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Fix with AI', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Load more jobs', exact: true }).click()
  await expect(page.getByText('Additional job', { exact: true })).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing store')
      }
      await store.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await page.waitForTimeout(250)
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading workflow details' })
    ).toHaveCount(0)
    await page.screenshot({ path: path.join(screenshotDir, `actions-details-${theme}.png`) })
  }
  const tabCount = await page.evaluate(
    () =>
      window.__store?.getState().openFiles.filter((file) => file.mode === 'check-details').length
  )
  await page
    .getByRole('heading', { name: run.displayTitle, exact: true })
    .locator('..')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click()
  await expect(page.getByText('Additional job', { exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        window.__store?.getState().openFiles.filter((file) => file.mode === 'check-details').length
    )
  ).toBe(tabCount)
  await page.getByRole('button', { name: 'Back to Actions', exact: true }).click()
  await expect(row).toBeVisible()
  await page.getByRole('textbox', { name: 'Branch', exact: true }).fill('no-match')
  await page.getByRole('textbox', { name: 'Branch', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled()
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gh:actionsRuns')
    ipcMain.handle('gh:actionsRuns', async () => {
      throw new Error('Synthetic authentication failure: sign in to GitHub')
    })
  })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Synthetic authentication failure: sign in to GitHub')).toBeVisible()
  await electronApp.evaluate(({ ipcMain }, repository) => {
    ipcMain.removeHandler('gh:actionsRuns')
    ipcMain.handle('gh:actionsRuns', async () => ({
      repository,
      page: 1,
      perPage: 50,
      totalCount: 0,
      items: [],
      hasNextPage: false,
      limitReached: false
    }))
  }, repository)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByText('No workflow runs match these filters.', { exact: true })
  ).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
