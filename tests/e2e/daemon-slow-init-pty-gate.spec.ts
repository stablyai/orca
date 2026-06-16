import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { ElectronApplication } from '@stablyai/playwright-test'
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
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

// Why: longer than FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS (12s) so the first
// window fails open before the daemon provider exists — the exact race that
// used to flip restored panes onto non-restorable LocalPtyProvider terminals
// (#5232 Bug 1) — but well under the 60s local-PTY fail-open cap.
const DAEMON_INIT_DELAY_MS = 15_000

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

test.describe.configure({ mode: 'serial' })

test('reattaches daemon PTYs when daemon init outlasts the first-window timeout', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    const ptyId = await discoverActivePtyId(page)
    expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

    const marker = `DAEMON_SLOW_INIT_GATE_${Date.now()}`
    await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(firstLaunch.page, marker)

    const daemonPidBefore = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // Why: session.launch() inherits this process's env, so this reaches the
    // relaunched app's main process and delays initDaemonPtyProvider past the
    // first-window timeout.
    process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS = String(DAEMON_INIT_DELAY_MS)
    try {
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app

      await waitForSessionReady(secondLaunch.page)
      await expect
        .poll(
          async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
          { timeout: 15_000 }
        )
        .toBe(worktreeId)
      await ensureTerminalVisible(secondLaunch.page)
      await waitForActiveTerminalManager(secondLaunch.page, 45_000)
      await waitForPaneCount(secondLaunch.page, 1, 45_000)
      // Why: pre-fix, the pane spawned a fresh LocalPtyProvider terminal here
      // (numeric pty id, no marker); post-fix it waits out the daemon init and
      // warm-reattaches the original daemon session.
      await waitForTerminalOutput(secondLaunch.page, marker, 45_000)

      const reattachedPtyId = await discoverActivePtyId(secondLaunch.page)
      expect(reattachedPtyId).toContain(PTY_SESSION_ID_SEPARATOR)
      expect(reattachedPtyId).toBe(ptyId)
      expect(readDaemonPid(session.userDataDir)).toBe(daemonPidBefore)
      expect(await getTerminalContent(secondLaunch.page)).not.toContain('--- session restored ---')
    } finally {
      delete process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS
    }
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
