import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

test('filters terminal-only child unread through the live Dock IPC subscription', async ({
  electronApp,
  orcaPage
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:setUnreadDockBadgeCount')
    ipcMain.handle('app:setUnreadDockBadgeCount', (_event, count: number) => {
      process.env.ORCA_TEST_CHILD_UNREAD_DOCK_COUNT = String(count)
    })
  })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { parentId, childId } = await seedLineageScenario(orcaPage)
  await worktreeRow(orcaPage, parentId).click()
  await orcaPage.evaluate((childId) => {
    const store = window.__store!
    const state = store.getState()
    const id = 'child-dock-unread-tab'
    store.setState({
      worktreesByRepo: Object.fromEntries(
        Object.entries(state.worktreesByRepo).map(([repoId, worktrees]) => [
          repoId,
          worktrees.map((worktree) =>
            worktree.id === childId ? { ...worktree, isUnread: false } : worktree
          )
        ])
      ),
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [childId]: [
          {
            id,
            worktreeId: childId,
            ptyId: null,
            title: 'Child',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [childId]: [
          {
            id,
            entityId: id,
            groupId: 'child-dock-group',
            worktreeId: childId,
            executionHostId: 'local',
            contentType: 'terminal',
            label: 'Child',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      unreadTerminalTabs: { [id]: true }
    })
  }, childId)
  const badge = () =>
    electronApp.evaluate(() => Number(process.env.ORCA_TEST_CHILD_UNREAD_DOCK_COUNT))
  await expect.poll(badge).toBe(1)
  for (const showChildWorktreeUnread of [false, true]) {
    await orcaPage.evaluate(async (showChildWorktreeUnread) => {
      const state = window.__store!.getState()
      if (!state.settings) {
        throw new Error('Settings are not hydrated')
      }
      await state.updateSettings({
        notifications: { ...state.settings.notifications, showChildWorktreeUnread }
      })
    }, showChildWorktreeUnread)
    await expect.poll(badge).toBe(showChildWorktreeUnread ? 1 : 0)
    expect(
      await orcaPage.evaluate(
        () => window.__store!.getState().unreadTerminalTabs['child-dock-unread-tab']
      )
    ).toBe(true)
  }
})
