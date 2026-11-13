import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** Start a long-lived child under the PTY shell, standing in for an agent CLI. */
async function startLongLivedChild(page: Page): Promise<number> {
  const tag = `STOP_${Date.now()}`
  const ptyId = await discoverActivePtyId(page)
  await execInTerminal(
    page,
    ptyId,
    `node -e "console.log('${tag}_PID=' + process.pid); setInterval(() => {}, 1000)"`
  )
  // Match digits, not the bare marker: the echoed command line contains the marker too.
  const pidPattern = new RegExp(`${tag}_PID=(\\d+)`)
  let pid = 0
  await expect
    .poll(
      async () => {
        pid = Number(pidPattern.exec(await getTerminalContent(page))?.[1] ?? 0)
        return pid
      },
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0)
  expect(isProcessAlive(pid)).toBe(true)
  return pid
}

test('stops terminal children on quit when enabled, then restores the tab', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  let childPid: number | null = null
  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
    await waitForSessionReady(firstLaunch.page)
    await waitForActiveWorktree(firstLaunch.page)
    await ensureTerminalVisible(firstLaunch.page)
    await waitForActiveTerminalManager(firstLaunch.page, 30_000)
    await waitForPaneCount(firstLaunch.page, 1, 30_000)
    const tabId = await getActiveTabId(firstLaunch.page)
    expect(tabId).not.toBeNull()

    await firstLaunch.page.evaluate(async () => {
      await window.__store?.getState().updateSettingsOrThrow({ stopTerminalSessionsOnQuit: true })
    })
    // will-quit reads the main-process store, not the renderer copy.
    await expect
      .poll(() =>
        firstLaunch.page.evaluate(
          async () => (await window.api.settings.get()).stopTerminalSessionsOnQuit === true
        )
      )
      .toBe(true)

    const stoppedPid = await startLongLivedChild(firstLaunch.page)
    childPid = stoppedPid

    const firstProcess = firstApp.process()
    await session.close(firstApp, { gracefulCloseTimeoutMs: 30_000 })
    firstApp = null

    // A forced tree kill on close would also end the PTY child; only a clean quit proves stop-on-quit did.
    expect({ exitCode: firstProcess.exitCode, signal: firstProcess.signalCode }).toEqual({
      exitCode: 0,
      signal: null
    })
    await expect.poll(() => isProcessAlive(stoppedPid), { timeout: 15_000 }).toBe(false)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(() => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 10_000
      })
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)
    await waitForPaneCount(secondLaunch.page, 1, 30_000)
    // A retired tab would come back as a new default terminal with a different id.
    await expect.poll(() => getActiveTabId(secondLaunch.page)).toBe(tabId)

    const freshMarker = `FRESH_${Date.now()}`
    // The restored pane spawns a new shell; Windows PowerShell can miss a probe sent during startup.
    let freshPtyId = ''
    await expect(async () => {
      freshPtyId = await discoverActivePtyId(secondLaunch.page)
    }).toPass({ timeout: 60_000 })
    await execInTerminal(secondLaunch.page, freshPtyId, `echo ${freshMarker}`)
    await waitForTerminalOutput(secondLaunch.page, freshMarker, 20_000)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    if (childPid !== null && isProcessAlive(childPid)) {
      process.kill(childPid)
    }
    await session.dispose()
  }
})
