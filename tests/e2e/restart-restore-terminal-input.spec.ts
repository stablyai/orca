// #2836: restored scrollback can paint before deferred reattach, leaving a live-looking input-dead pane.
// Require input after clean daemon-preserving restart, stalled-daemon recovery and daemon-killed cold spawn; content-only checks miss all three.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
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
import {
  buildFrozenPaneReport,
  getStorePtyIds,
  probeDirectWrite,
  probeKeyboardType,
  probeOwnershipRebuildRevival
} from './helpers/terminal-input-probes'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

const REQUIRE_WINDOWS_TERMINAL_RESTART_E2E =
  process.env.ORCA_REQUIRE_WINDOWS_TERMINAL_RESTART_E2E === '1'

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function terminateDaemonForColdRestart(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'pipe',
        timeout: 10_000
      })
    } catch (error) {
      if (isProcessAlive(pid)) {
        throw error
      }
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      // Tolerate ESRCH if the daemon exits between liveness check and signal, matching Windows revalidation.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  await expect
    .poll(() => isProcessAlive(pid), {
      timeout: 10_000,
      message: `daemon ${pid} remained alive after forced termination`
    })
    .toBe(false)
}

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  const unavailable = !repoPath || !existsSync(repoPath)
  if (unavailable && REQUIRE_WINDOWS_TERMINAL_RESTART_E2E) {
    throw new Error('Required Windows restart E2E seeded repo is unavailable')
  }
  test.skip(unavailable, 'Global setup did not produce a seeded test repo')
  return repoPath
}

async function bootstrapFirstLaunch(
  page: Page,
  repoPath: string
): Promise<{ ptyId: string; marker: string }> {
  await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  const ptyId = await discoverActivePtyId(page)
  // Require daemon-form ids so fallback local providers cannot bypass the restore path.
  expect(ptyId, 'expected a daemon-backed PTY session').toContain(PTY_SESSION_ID_SEPARATOR)
  const marker = `RESTORE_INPUT_PRE_${Date.now()}`
  await execInTerminal(page, ptyId, `echo ${marker}`)
  await waitForTerminalOutput(page, marker)
  return { ptyId, marker }
}

async function settleRestoredLaunch(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
}

// Require restored input and report which transport layer fails.
async function expectRestoredPaneAcceptsInput(page: Page, context: string): Promise<void> {
  const ptyIds = await getStorePtyIds(page)
  const readinessAlive =
    ptyIds.length > 0 && (await waitForRestoredTerminalInputReady(page, ptyIds[0], 15_000))
  const kbAlive = readinessAlive && (await probeKeyboardType(page, 'KB_RESTORED_OK', 15_000))
  const directAlive =
    ptyIds.length > 0 && (await probeDirectWrite(page, ptyIds[0], 'DIRECT_RESTORED_OK', 15_000))
  if (!readinessAlive || !kbAlive || !directAlive) {
    const ownershipRebuildAttempted = !directAlive && ptyIds.length > 0
    const revived =
      ownershipRebuildAttempted &&
      (await probeOwnershipRebuildRevival(page, ptyIds[0], 'REVIVED_RESTORED_OK'))
    throw new Error(
      buildFrozenPaneReport(context, {
        directAlive,
        transportAlive: kbAlive,
        revivedByOwnershipRebuild: revived,
        ownershipRebuildAttempted,
        readinessAlive,
        ptyIds,
        terminalTail: await getTerminalContent(page)
      })
    )
  }
}

test.describe.configure({ mode: 'serial' })

test('restored pane accepts typing after a clean restart with a live daemon session', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    const { marker } = await bootstrapFirstLaunch(first.page, repoPath)
    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await settleRestoredLaunch(second.page)
    await waitForTerminalOutput(second.page, marker, 15_000)
    expect(readDaemonPid(session.userDataDir), 'daemon must survive the restart').toBe(daemonPid)

    await expectRestoredPaneAcceptsInput(second.page, 'clean restart, live daemon session')
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

test('restored pane recovers input after the daemon un-wedges', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'SIGSTOP/SIGCONT are POSIX-only')
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  let stoppedDaemonPid: number | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    const { marker } = await bootstrapFirstLaunch(first.page, repoPath)
    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // SIGSTOP retains socket/sessions while preventing daemon responses during relaunch.
    process.kill(daemonPid, 'SIGSTOP')
    stoppedDaemonPid = daemonPid

    const second = await session.launch()
    secondApp = second.app

    // Record whether restore paints while attach stalls, matching the reported visible-but-dead interval.
    const paintedWhileWedged = (await getTerminalContent(second.page)).includes(marker)

    // Hardening may replace the stopped daemon; record that outcome and require typeable recovery either way.
    let daemonReplacedWhileWedged = false
    try {
      process.kill(daemonPid, 'SIGCONT')
    } catch {
      daemonReplacedWhileWedged = true
    }
    stoppedDaemonPid = null

    // Session readiness requires a daemon response; resume it before waiting for restoration.
    await settleRestoredLaunch(second.page)
    await expectRestoredPaneAcceptsInput(
      second.page,
      `daemon wedged during relaunch (painted while wedged: ${paintedWhileWedged}, ` +
        `wedged daemon killed+replaced by relaunch: ${daemonReplacedWhileWedged})`
    )
  } finally {
    if (stoppedDaemonPid !== null) {
      try {
        process.kill(stoppedDaemonPid, 'SIGCONT')
      } catch {
        // daemon already gone
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

test('cold-restored pane accepts typing after the daemon died between launches', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const first = await session.launch()
    firstApp = first.app
    await bootstrapFirstLaunch(first.page, repoPath)
    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // Kill between launches so saved bindings point at sessions no daemon retains.
    await terminateDaemonForColdRestart(daemonPid)

    const second = await session.launch()
    secondApp = second.app
    await settleRestoredLaunch(second.page)

    await expectRestoredPaneAcceptsInput(second.page, 'daemon killed between launches')
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
