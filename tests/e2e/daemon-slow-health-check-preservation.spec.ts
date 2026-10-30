import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
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
import { E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV } from '../../src/main/daemon/daemon-health'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

// Delay guard decisions beyond electron.launch so the test can attach its stderr listener.
const GUARD_DECISION_DELAY_MS = 3_000

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

test('preserves a live daemon PTY when the daemon is too slow for the startup health check', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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

    const marker = `DAEMON_SLOW_HEALTH_PRESERVE_${Date.now()}`
    await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(firstLaunch.page, marker)

    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    const stderrLines: string[] = []
    // Force only health unreachable: SIGSTOP also blocks listSessions and races the preserve decision.
    // Delay init until Playwright releases stderr after launch or the decision log is lost.
    const secondLaunch = await session.launch({
      extraEnv: {
        [E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV]: '1',
        ORCA_E2E_DAEMON_INIT_DELAY_MS: String(GUARD_DECISION_DELAY_MS)
      },
      onStderr: (chunk) => stderrLines.push(chunk)
    })
    secondApp = secondLaunch.app

    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(
        async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        { timeout: 15_000 }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)
    await waitForPaneCount(secondLaunch.page, 1, 30_000)
    await waitForTerminalOutput(secondLaunch.page, marker, 20_000)

    // A stable PID also passes healthy adoption; require the guard’s preserve decision to prove this failure path ran.
    await expect
      .poll(() => stderrLines.join(''), { timeout: 10_000 })
      .toMatch(/preserv\w*\s+daemon[^\n]*health check/i)
    expect(readDaemonPid(session.userDataDir)).toBe(daemonPid)
    expect(stderrLines.join('')).not.toMatch(/\breplacing daemon\b/i)
    // Cold restore can replay the marker; absence of its banner distinguishes a live session.
    expect(await getTerminalContent(secondLaunch.page)).not.toContain('--- session restored ---')
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
