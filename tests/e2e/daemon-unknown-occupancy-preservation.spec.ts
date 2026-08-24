import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
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
import {
  E2E_DISABLE_UNKNOWN_OCCUPANCY_HOLD_ENV,
  E2E_FORCE_DAEMON_INVENTORY_UNAVAILABLE_ENV
} from '../../src/main/daemon/daemon-supervision-fault-injection'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  processIdentityIsAlive,
  recordProcessIdentity,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'

const GUARD_DECISION_DELAY_MS = 3_000

function readDaemonPid(userDataDir: string): number {
  const pidPath = path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
  const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${readFileSync(pidPath)}`)
  }
  return parsed.pid
}

async function recordTerminalShell(page: Parameters<typeof getTerminalContent>[0]) {
  const marker = `ORCA_SHELL_PID_${Date.now()}`
  const ptyId = await discoverActivePtyId(page)
  await execInTerminal(page, ptyId, `node -e "console.log('${marker}=' + process.ppid)"`)
  await waitForTerminalOutput(page, `${marker}=`)
  const match = new RegExp(`${marker}=(\\d+)`).exec(await getTerminalContent(page))
  if (!match) {
    throw new Error('Terminal shell pid marker was not observed')
  }
  return { ptyId, identity: await recordProcessIdentity(Number(match[1])) }
}

async function expectIdentityAlive(
  identity: RecordedProcessIdentity,
  alive: boolean
): Promise<void> {
  await expect.poll(() => processIdentityIsAlive(identity), { timeout: 15_000 }).toBe(alive)
}

async function runOracle(testInfo: TestInfo, holdEnabled: boolean): Promise<void> {
  testInfo.setTimeout(120_000)
  test.skip(process.platform !== 'win32', 'Windows process-identity oracle')
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
    await waitForSessionReady(firstLaunch.page)
    await waitForActiveWorktree(firstLaunch.page)
    await ensureTerminalVisible(firstLaunch.page)
    await waitForActiveTerminalManager(firstLaunch.page, 30_000)
    await waitForPaneCount(firstLaunch.page, 1, 30_000)

    const shell = await recordTerminalShell(firstLaunch.page)
    const beforeMarker = `UNKNOWN_OCCUPANCY_BEFORE_${Date.now()}`
    await execInTerminal(firstLaunch.page, shell.ptyId, `echo ${beforeMarker}`)
    await waitForTerminalOutput(firstLaunch.page, beforeMarker)
    const daemon = await recordProcessIdentity(readDaemonPid(session.userDataDir))

    await session.close(firstApp)
    firstApp = null
    await expectIdentityAlive(daemon, true)
    await expectIdentityAlive(shell.identity, true)

    const stderrLines: string[] = []
    const secondLaunch = await session.launch({
      extraEnv: {
        [E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV]: '1',
        [E2E_FORCE_DAEMON_INVENTORY_UNAVAILABLE_ENV]: '1',
        ...(holdEnabled ? {} : { [E2E_DISABLE_UNKNOWN_OCCUPANCY_HOLD_ENV]: '1' }),
        ORCA_E2E_DAEMON_INIT_DELAY_MS: String(GUARD_DECISION_DELAY_MS)
      },
      onStderr: (chunk) => stderrLines.push(chunk)
    })
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)

    if (!holdEnabled) {
      await expectIdentityAlive(daemon, false)
      await expectIdentityAlive(shell.identity, false)
      await expect
        .poll(() => stderrLines.join(''), { timeout: 10_000 })
        .toMatch(/replacing daemon/i)
      return
    }

    await expectIdentityAlive(daemon, true)
    await expectIdentityAlive(shell.identity, true)
    expect(readDaemonPid(session.userDataDir)).toBe(daemon.pid)
    await expect.poll(() => stderrLines.join(''), { timeout: 10_000 }).toMatch(/holding daemon/i)
    expect(stderrLines.join('')).not.toMatch(/replacing daemon/i)

    await expect
      .poll(() => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)
    await waitForPaneCount(secondLaunch.page, 1, 30_000)
    await waitForTerminalOutput(secondLaunch.page, beforeMarker, 20_000)
    expect(await getTerminalContent(secondLaunch.page)).not.toContain('--- session restored ---')

    const afterMarker = `UNKNOWN_OCCUPANCY_AFTER_${Date.now()}`
    await execInTerminal(secondLaunch.page, shell.ptyId, `echo ${afterMarker}`)
    await waitForTerminalOutput(secondLaunch.page, afterMarker, 20_000)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
}

test.describe.configure({ mode: 'serial' })

test('@headful preserves daemon and shell identities when occupancy is unknown', async (// oxlint-disable-next-line no-empty-pattern -- This oracle owns an isolated two-launch fixture.
{}, testInfo) => {
  await runOracle(testInfo, true)
})

test('@headful same oracle destroys identities when the hold is disabled', async (// oxlint-disable-next-line no-empty-pattern -- This oracle owns an isolated two-launch fixture.
{}, testInfo) => {
  await runOracle(testInfo, false)
})
