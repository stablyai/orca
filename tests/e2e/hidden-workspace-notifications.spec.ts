import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { execInTerminal, waitForActivePanePtyId } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getRendererTitleLog, installRendererTitleLog } from './helpers/terminal-title-log'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'

type NotificationDispatch = { source?: string; worktreeId?: string }

declare global {
  var __hiddenWorkspaceDispatchLog: NotificationDispatch[] | undefined
}

async function installNotificationDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    if (globalThis.__hiddenWorkspaceDispatchLog) {
      return
    }
    const log: NotificationDispatch[] = []
    globalThis.__hiddenWorkspaceDispatchLog = log
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, args: NotificationDispatch) => {
      log.push(args)
      return { delivered: true }
    })
  })
}

async function bellRequests(app: ElectronApplication, worktreeId: string): Promise<number> {
  return app.evaluate((_electron, id) => {
    return (globalThis.__hiddenWorkspaceDispatchLog ?? []).filter(
      (dispatch) => dispatch.source === 'terminal-bell' && dispatch.worktreeId === id
    ).length
  }, worktreeId)
}

async function isWorkspaceUnread(page: Page, worktreeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return Object.values(state.worktreesByRepo)
      .flat()
      .some((worktree) => worktree.id === id && worktree.isUnread)
  }, worktreeId)
}

/** Rings a BEL with the workspace off screen (Settings open), fenced by an OSC title marker. */
async function ringBellOffScreen(
  page: Page,
  ptyId: string,
  worktreeId: string,
  marker: string
): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    const row = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === id)
    state.setWorkspaceUnreadByUser(id, false, row?.hostId ?? 'local')
    state.openSettingsPage()
  }, worktreeId)
  await execInTerminal(page, ptyId, `printf '\\a\\033]0;${marker}\\007'`)
  await expect
    .poll(async () => (await getRendererTitleLog(page)).includes(marker), {
      timeout: 10_000,
      message: 'Marker title did not land, so the BEL may not have reached the renderer'
    })
    .toBe(true)
}

async function setFilterAndSetting(
  page: Page,
  hideDefaultBranch: boolean,
  notifyHiddenWorkspaces: boolean
): Promise<void> {
  await page.evaluate(
    async ({ hide, notify }) => {
      const state = window.__store!.getState()
      state.setHideDefaultBranchWorkspace(hide)
      await state.updateSettings({
        notifications: { ...state.settings!.notifications, notifyHiddenWorkspaces: notify }
      })
    },
    { hide: hideDefaultBranch, notify: notifyHiddenWorkspaces }
  )
  // A switch-on build's host reads the persisted switch, written after the window's copy.
  await expect
    .poll(() => page.evaluate(async () => (await window.api.ui.get()).hideDefaultBranchWorkspace))
    .toBe(hideDefaultBranch)
}

test.describe('Hidden workspace notifications', () => {
  test('a workspace hidden by a Filters switch raises nothing unless hidden workspaces notify', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
    await installNotificationDispatchSpy(electronApp)
    await installRendererTitleLog(orcaPage)
    // The seeded active workspace is the primary checkout, which "Hide default branch" hides.
    expect(
      await orcaPage.evaluate(
        (id) =>
          Object.values(window.__store!.getState().worktreesByRepo)
            .flat()
            .find((worktree) => worktree.id === id)?.isMainWorktree,
        worktreeId
      )
    ).toBe(true)

    // Visible: unread and a banner request, as before.
    await setFilterAndSetting(orcaPage, false, false)
    await ringBellOffScreen(orcaPage, ptyId, worktreeId, 'hwn-visible')
    await expect.poll(() => bellRequests(electronApp, worktreeId), { timeout: 5_000 }).toBe(1)
    expect(await isWorkspaceUnread(orcaPage, worktreeId)).toBe(true)

    // Hidden and the setting off: no request, past the bell's 250 ms delay. The window raises no
    // dot; a switch-on host raises its shared dot, which ignores every client's Filters.
    await setFilterAndSetting(orcaPage, true, false)
    await ringBellOffScreen(orcaPage, ptyId, worktreeId, 'hwn-hidden')
    if (SIDEBAR_INPUTS_BUILD) {
      await expect.poll(() => isWorkspaceUnread(orcaPage, worktreeId)).toBe(true)
    }
    await orcaPage.waitForTimeout(1_500)
    expect(await bellRequests(electronApp, worktreeId)).toBe(1)
    expect(await isWorkspaceUnread(orcaPage, worktreeId)).toBe(SIDEBAR_INPUTS_BUILD)

    // Hidden with "Notify About Hidden Workspaces" on: both come back.
    await setFilterAndSetting(orcaPage, true, true)
    await ringBellOffScreen(orcaPage, ptyId, worktreeId, 'hwn-opted-in')
    await expect.poll(() => bellRequests(electronApp, worktreeId), { timeout: 5_000 }).toBe(2)
    expect(await isWorkspaceUnread(orcaPage, worktreeId)).toBe(true)
  })
})
