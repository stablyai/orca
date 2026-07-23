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
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

// Why: must land after the relaunched app's 3s daemon health check has timed
// out (so the unhealthy guard runs) but before the guard's 5s client hello
// budget expires. Daemon init starts within the first ~2s of main startup.
const RESUME_DAEMON_AFTER_MS = 6_500

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
  test.skip(process.platform === 'win32', 'SIGSTOP/SIGCONT are POSIX-only')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  let daemonPid: number | null = null

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

    daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // Why: a stopped daemon still accepts socket connections at the kernel
    // level but answers nothing — the same observable behavior as a daemon
    // that is too busy to respond within the health-check budget.
    process.kill(daemonPid, 'SIGSTOP')

    const stderrLines: string[] = []
    const resumeTimer = setTimeout(() => {
      if (daemonPid !== null) {
        process.kill(daemonPid, 'SIGCONT')
      }
    }, RESUME_DAEMON_AFTER_MS)
    try {
      // Why: capture stderr from process start — the daemon guard logs its
      // preservation decision during main-process startup, which can complete
      // before firstWindow resolves, so a post-launch listener would miss it.
      const secondLaunch = await session.launch({
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

      // The guard path must actually have run and chosen preserve over replace:
      // the daemon failed the health check yet was kept because its live session
      // was verified. Match the stable "preserve…daemon…health check" concepts
      // (not the exact wording) so a benign log reword doesn't flake, and
      // confirm the replace path stayed off.
      await expect
        .poll(() => stderrLines.join(''), { timeout: 10_000 })
        .toMatch(/preserv\w*\s+daemon[^\n]*health check/i)
      expect(stderrLines.join('')).not.toMatch(/\breplacing daemon\b/i)
      expect(readDaemonPid(session.userDataDir)).toBe(daemonPid)
      // Why: a killed daemon cold-restores scrollback from history, so the
      // marker text alone cannot distinguish a live session from a dead one.
      // The restore banner only appears for cold-restored (dead) sessions.
      expect(await getTerminalContent(secondLaunch.page)).not.toContain('--- session restored ---')
    } finally {
      clearTimeout(resumeTimer)
    }
  } finally {
    if (daemonPid !== null) {
      try {
        // Idempotent: ensures the daemon is resumable for harness cleanup even
        // if the test failed before the resume timer fired.
        process.kill(daemonPid, 'SIGCONT')
      } catch {
        // Daemon already gone
      }
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
})
