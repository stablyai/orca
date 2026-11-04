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
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function bootstrap(page: Page, repoPath: string): Promise<{ worktreeId: string }> {
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  return { worktreeId }
}

async function setStopOnQuit(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    await window.__store?.getState().updateSettingsOrThrow({ stopTerminalSessionsOnQuit: enabled })
  }, enabled)
  // will-quit reads the main-process store, not the renderer copy.
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.api.settings.get()).stopTerminalSessionsOnQuit === true
      )
    )
    .toBe(enabled)
}

/** Start a long-lived child under the PTY shell, standing in for an agent CLI. */
async function startLongLivedChild(page: Page, tag: string): Promise<number> {
  const ptyId = await discoverActivePtyId(page)
  await execInTerminal(
    page,
    ptyId,
    `node -e "console.log('${tag}_PID=' + process.pid); setInterval(() => {}, 1000)"`
  )
  await waitForTerminalOutput(page, `${tag}_PID=`, 20_000)
  const content = await getTerminalContent(page)
  const match = new RegExp(`${tag}_PID=(\\d+)`).exec(content)
  if (!match) {
    throw new Error(`Child PID marker missing from terminal output: ${content.slice(-500)}`)
  }
  const pid = Number(match[1])
  expect(isProcessAlive(pid)).toBe(true)
  return pid
}

test.describe.configure({ mode: 'serial' })

test('keeps terminal children alive across quit when the setting is off', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  let childPid: number | null = null
  try {
    const launch = await session.launch()
    app = launch.app
    await bootstrap(launch.page, repoPath)
    await setStopOnQuit(launch.page, false)
    childPid = await startLongLivedChild(launch.page, `KEEP_${Date.now()}`)

    await session.close(app)
    app = null

    // Control: proves the harness quit is graceful, so the enabled case below is not a tree-kill artifact.
    expect(isProcessAlive(childPid)).toBe(true)
  } finally {
    if (app) {
      await session.close(app)
    }
    if (childPid !== null && isProcessAlive(childPid)) {
      process.kill(childPid)
    }
    await session.dispose()
  }
})

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
    const { worktreeId } = await bootstrap(firstLaunch.page, repoPath)
    await setStopOnQuit(firstLaunch.page, true)
    const stoppedPid = await startLongLivedChild(firstLaunch.page, `STOP_${Date.now()}`)
    childPid = stoppedPid

    await session.close(firstApp)
    firstApp = null

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
