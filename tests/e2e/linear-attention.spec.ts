import { mkdirSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

for (const workspaceKind of ['worktree', 'folder'] as const) {
  test(`read-only attention in ${workspaceKind} separates notifications, Triage and profile changes`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    if (workspaceKind === 'folder') {
      const directory = testInfo.outputPath('folder-project')
      mkdirSync(directory, { recursive: true })
      await orcaPage.evaluate(async (folder) => {
        const repo = await window.__store!.getState().addNonGitFolder(folder)
        if (!repo || repo.kind !== 'folder') {
          throw new Error('Folder project was not created')
        }
      }, directory)
    }
    const profileId = await orcaPage.evaluate(() => window.__store!.getState().activeOrcaProfileId)
    await electronApp.evaluate(({ ipcMain }, owner) => {
      const workspace = {
        id: 'attention-org',
        organizationId: 'attention-org',
        organizationName: 'Attention fixture',
        organizationUrlKey: 'attention-fixture',
        displayName: 'Fixture user',
        email: null,
        viewerId: 'attention-viewer',
        credentialOwnerProfileId: owner,
        credentialRevision: 1,
        credentialEpoch: 'attention-epoch'
      }
      const status = {
        connected: true,
        viewer: workspace,
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        selectedWorkspaceId: workspace.id
      }
      ipcMain.removeHandler('linear:status')
      ipcMain.handle('linear:status', () => status)
      ipcMain.removeHandler('linear:listTeams')
      ipcMain.handle('linear:listTeams', () => [
        { id: 'attention-team', workspaceId: workspace.id, name: 'Engineering', key: 'ENG' }
      ])
      ipcMain.removeHandler('linear:listIssues')
      ipcMain.handle('linear:listIssues', () => ({ items: [] }))
      for (const channel of ['linear:teamStates', 'linear:teamLabels', 'linear:teamMembers']) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => [])
      }
      const issue = {
        id: 'attention-issue',
        workspaceId: workspace.id,
        identifier: 'ENG-1',
        title: 'Review the launch checklist',
        url: 'https://linear.app/attention-fixture/issue/ENG-1',
        state: { name: 'Triage', type: 'triage', color: '' },
        team: { id: 'attention-team', name: 'Engineering', key: 'ENG' },
        labels: [],
        priority: 0,
        updatedAt: '2026-09-21T00:00:00Z'
      }
      ipcMain.removeHandler('linear:getIssue')
      ipcMain.handle('linear:getIssue', () => issue)
      ipcMain.removeHandler('linear:personalInbox')
      ipcMain.handle('linear:personalInbox', (_event, args) => ({
        scope: {
          profileId: owner,
          workspaceId: workspace.id,
          viewerId: workspace.viewerId,
          credentialRevision: 1,
          credentialEpoch: workspace.credentialEpoch
        },
        items: [
          {
            id: args.cursor ? 'next' : 'notification',
            kind: args.cursor ? 'ProjectNotification' : 'IssueNotification',
            type: 'mention',
            title: args.cursor ? 'Project update' : 'Review the launch checklist',
            subtitle: 'A teammate mentioned you',
            url: 'https://linear.app/attention-fixture/issue/ENG-1',
            readAt: null,
            snoozedUntilAt: args.cursor ? '2026-10-01T00:00:00Z' : null,
            updatedAt: '2026-09-21T00:00:00Z',
            issue: args.cursor ? null : issue
          }
        ],
        nextCursor: args.cursor ? null : 'page-two'
      }))
      ipcMain.removeHandler('linear:triagePage')
      ipcMain.handle('linear:triagePage', () => ({
        items: [],
        nextCursor: null,
        unavailable: 'Triage is not enabled for this team in Linear.'
      }))
    }, profileId)
    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      await state.checkLinearConnection(true)
      state.openTaskPage({ taskSource: 'linear' })
    })
    await orcaPage.screenshot({ path: testInfo.outputPath('linear-before.png') })
    await orcaPage.getByRole('button', { name: 'Inbox and Triage', exact: true }).click()
    await expect(orcaPage.getByText('Review the launch checklist', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Unread', { exact: true })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Load more', exact: true }).click()
    await expect(orcaPage.getByText('Project update', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Project', { exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Investigate', exact: true })).toHaveCount(0)
    await expect(orcaPage.getByRole('button', { name: 'Open issue', exact: true })).toHaveCount(1)
    await orcaPage.screenshot({ path: testInfo.outputPath('linear-inbox.png') })
    await orcaPage.getByRole('button', { name: 'Team Triage', exact: true }).click()
    await expect(
      orcaPage.getByText('Triage is not enabled for this team in Linear.', { exact: true })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('linear-triage-disabled.png') })
    await orcaPage.getByRole('button', { name: 'Personal Inbox', exact: true }).click()
    await expect(orcaPage.getByText('Review the launch checklist', { exact: true })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Open issue', exact: true }).click()
    await expect(
      orcaPage.getByRole('button', { name: 'Inbox and Triage', exact: true })
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Inbox and Triage', exact: true }).click()
    await expect(orcaPage.getByText('Review the launch checklist', { exact: true })).toBeVisible()
    await orcaPage.evaluate(() =>
      window.__store!.setState({ activeOrcaProfileId: 'other-profile' })
    )
    await expect(orcaPage.getByText('Review the launch checklist', { exact: true })).toHaveCount(0)
    await expect(
      orcaPage.getByText(
        'Reconnect Linear in this Orca profile to confirm your personal Inbox identity.',
        { exact: true }
      )
    ).toBeVisible()
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  })
}
