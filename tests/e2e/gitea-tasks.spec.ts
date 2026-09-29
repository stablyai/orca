import { test, expect } from './helpers/orca-app'

test('Gitea issue edits and comments keep the saved title and author', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const issue = {
      id: 42,
      number: 42,
      type: 'issue',
      repoOwner: 'example',
      repoName: 'project',
      title: 'Keep organization labels when editing an issue',
      body: 'A reproducible Gitea task for review.',
      state: 'open',
      url: 'https://gitea.example.com/example/project/issues/42',
      labels: ['organization'],
      labelIds: [999],
      assignees: [],
      comments: 0,
      createdAt: '2026-09-01T12:00:00Z',
      updatedAt: '2026-09-01T12:00:00Z'
    }
    const comments: {
      id: number
      body: string
      createdAt: string
      user: { id: number; login: string }
    }[] = []
    for (const channel of [
      'status',
      'listWorkItems',
      'issue',
      'issueComments',
      'labels',
      'assignees',
      'updateIssue',
      'addIssueComment'
    ]) {
      ipcMain.removeHandler(`gitea:${channel}`)
    }
    ipcMain.handle('gitea:status', () => ({ connected: true }))
    ipcMain.handle('gitea:listWorkItems', () => [issue])
    ipcMain.handle('gitea:issue', () => issue)
    ipcMain.handle('gitea:issueComments', () => comments)
    ipcMain.handle('gitea:labels', () => [{ id: 1, name: 'bug' }])
    ipcMain.handle('gitea:assignees', () => [])
    ipcMain.handle('gitea:updateIssue', (_event, args) => {
      Object.assign(issue, args.updates)
      return { ok: true }
    })
    ipcMain.handle('gitea:addIssueComment', (_event, args) => {
      comments.push({
        id: 1,
        body: args.body,
        createdAt: '2026-09-28T12:00:00Z',
        user: { id: 1, login: 'reviewer' }
      })
      return { ok: true }
    })
  })
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store || !store.getState().settings) {
      throw new Error('Expected ready settings')
    }
    const settings = store.getState().settings
    if (!settings) {
      throw new Error('Expected settings')
    }
    store.setState({
      settings: {
        ...settings,
        uiLanguage: 'en',
        visibleTaskProviders: ['gitea'],
        defaultTaskSource: 'gitea'
      },
      repos: store.getState().repos.map((repo) => ({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'gitea.example.com/example/project',
          remoteName: 'origin',
          remoteUrl: 'https://gitea.example.com/example/project.git'
        }
      })),
      giteaStatus: { connected: true },
      giteaStatusLoaded: true
    })
    store.getState().openTaskPage({ taskSource: 'gitea' })
  })
  await orcaPage
    .getByText('Keep organization labels when editing an issue', { exact: true })
    .click()
  const title = orcaPage.getByRole('textbox', { name: 'Title', exact: true })
  await expect(title).toHaveValue('Keep organization labels when editing an issue')
  await orcaPage.screenshot({ path: testInfo.outputPath('before-edit.png') })
  await title.fill('Preserve labels and show the saved title')
  await title.press('Enter')
  await expect(
    orcaPage
      .locator('h2:not([data-slot])')
      .filter({ hasText: 'Preserve labels and show the saved title' })
  ).toBeVisible()
  await orcaPage
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Confirmed with a reproducible test.')
  await orcaPage.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(orcaPage.getByText('reviewer', { exact: true })).toBeVisible()
  await expect(
    orcaPage.getByText('Confirmed with a reproducible test.', { exact: true })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('after-edit.png') })
})
