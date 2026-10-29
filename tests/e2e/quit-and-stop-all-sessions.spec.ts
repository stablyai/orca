import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { waitForExit } from './helpers/electron-process-shutdown'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { readDaemonPidRecord } from '../../src/main/daemon/daemon-endpoint-incarnation'
import { getDaemonPidPath } from '../../src/main/daemon/daemon-spawner'

// The label is localized; the app menu gives the item a stable id.
const MENU_ITEM_ID = 'quit-and-stop-all-sessions'

function readDaemonPid(userDataDir: string): number {
  const pid = readDaemonPidRecord(getDaemonPidPath(path.join(userDataDir, 'daemon')))?.pid
  if (pid === undefined) {
    throw new Error('The daemon pid file is missing or unreadable')
  }
  return pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Why stub the dialog: the confirmation is a native message box Playwright cannot click.
async function confirmQuitAndStopAllSessionsFromMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu, dialog }, id) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    if (!item) {
      throw new Error(`${id} menu item was not registered`)
    }
    // The handler ignores Electron's click arguments.
    item.click()
  }, MENU_ITEM_ID)
}

test('Quit Completely closes the terminal tab and ends its shell and the daemon', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX shell pid probe')
  // Two Electron launches (quit, then relaunch) plus waits for the shell and daemon to exit.
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await waitForPaneCount(first.page, 1, 30_000)
    const ptyId = await discoverActivePtyId(first.page)
    const tabId = await first.page.evaluate(() => window.__store?.getState().activeTabId ?? null)
    expect(tabId).not.toBeNull()

    // Why the digits-only pattern: the echoed command line shows `$$`, never digits.
    await execInTerminal(first.page, ptyId, 'echo STOP_ALL_SHELL_PID_$$')
    const readShellPid = async (): Promise<number | null> => {
      const match = /STOP_ALL_SHELL_PID_(\d+)/.exec(await getTerminalContent(first.page))
      return match ? Number(match[1]) : null
    }
    await expect.poll(readShellPid, { timeout: 20_000 }).not.toBeNull()
    const shellPid = await readShellPid()
    if (shellPid === null) {
      throw new Error('The shell pid vanished from the terminal buffer')
    }
    const daemonPid = readDaemonPid(session.userDataDir)
    expect(isAlive(shellPid)).toBe(true)
    expect(isAlive(daemonPid)).toBe(true)

    // Why the exit event, not a poll: session.close needs app.process(), which Playwright drops soon after exit.
    const exited = waitForExit(first.app.process(), 60_000)
    await confirmQuitAndStopAllSessionsFromMenu(first.app)
    expect(await exited, 'Orca stayed open after Quit Completely').toBe(true)
    await session.close(first.app)
    firstApp = null

    await expect.poll(() => isAlive(shellPid), { timeout: 15_000 }).toBe(false)
    await expect.poll(() => isAlive(daemonPid), { timeout: 15_000 }).toBe(false)

    // The worktree stays in the sidebar, but the closed terminal tab does not come back, so
    // nothing resumes in it.
    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await expect(
      second.page.locator(`[role="option"][data-worktree-id="${worktreeId}"]`)
    ).toBeVisible({ timeout: 30_000 })
    const restoredTabIds = await second.page.evaluate(
      (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
      worktreeId
    )
    expect(restoredTabIds).not.toContain(tabId)
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
