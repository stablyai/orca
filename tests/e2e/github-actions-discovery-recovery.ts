import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test('Actions discovery failure remains reachable and recovers without changing workspace', async ({
  orcaPage: page,
  electronApp
}) => {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gh:repoSlug')
    ipcMain.handle('gh:repoSlug', async () => {
      throw new Error('Synthetic SSH discovery unavailable')
    })
  })
  await page.waitForTimeout(8000)
  await page.evaluate(() => {
    const store = window.__store!
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/recovery',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/acme/recovery.git'
        }
      }))
    }))
    store.getState().openTaskPage({ taskSource: 'github' })
  })
  const workspace = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByText('Synthetic SSH discovery unavailable')).toBeVisible()
  await electronApp.evaluate(({ ipcMain }) => {
    const repository = { owner: 'acme', repo: 'recovery', host: 'github.com' }
    ipcMain.removeHandler('gh:repoSlug')
    ipcMain.handle('gh:repoSlug', async (_event, args) => {
      if (!args.requireVerifiedSshProbe) {
        throw new Error('Actions discovery must request a verified probe')
      }
      return repository
    })
    ipcMain.removeHandler('gh:actionsWorkflows')
    ipcMain.handle('gh:actionsWorkflows', async () => ({
      repository,
      page: 1,
      perPage: 100,
      items: [],
      totalCount: 0,
      hasNextPage: false,
      limitReached: false
    }))
    ipcMain.removeHandler('gh:actionsRuns')
    ipcMain.handle('gh:actionsRuns', async () => ({
      repository,
      page: 1,
      perPage: 50,
      totalCount: 1,
      hasNextPage: false,
      limitReached: false,
      items: [
        {
          id: 1,
          workflowId: 1,
          runNumber: 1,
          runAttempt: 1,
          name: 'Recovered workflow',
          displayTitle: 'Recovered repository run',
          status: 'queued',
          conclusion: null,
          headBranch: 'main',
          headSha: null,
          actor: null,
          event: 'push',
          htmlUrl: null,
          createdAt: null,
          updatedAt: null,
          runStartedAt: null
        }
      ]
    }))
  })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: /Recovered repository run/ })).toBeVisible()
  await expect(page.getByText('Synthetic SSH discovery unavailable')).toHaveCount(0)
  expect(await page.evaluate(() => window.__store?.getState().activeWorktreeId)).toBe(workspace)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
