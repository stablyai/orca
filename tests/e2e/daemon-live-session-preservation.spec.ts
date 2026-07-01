import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

function daemonPidPath(userDataDir: string): string {
  return path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(daemonPidPath(userDataDir), 'utf8')
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

function spoofDaemonEntryPath(userDataDir: string): void {
  const pidPath = daemonPidPath(userDataDir)
  const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as Record<string, unknown>
  parsed.entryPath = '/tmp/orca-e2e-old-app/out/main/daemon-entry.js'
  writeFileSync(pidPath, `${JSON.stringify(parsed)}\n`)
}

async function bootstrapLaunch(
  app: ElectronApplication,
  repoPath: string
): Promise<{ ptyId: string; worktreeId: string }> {
  const page = await app.firstWindow()
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  const ptyId = await discoverActivePtyId(page)
  return { ptyId, worktreeId }
}

test.describe.configure({ mode: 'serial' })

test('preserves a live daemon PTY when the daemon launch identity is stale', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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
    const { ptyId, worktreeId } = await bootstrapLaunch(firstApp, repoPath)
    expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

    const marker = `DAEMON_LIVE_PRESERVE_${Date.now()}`
    await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(firstLaunch.page, marker)

    const daemonPidBefore = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // Why: this simulates the exact app-path mismatch that can happen after a
    // dev-path change or app update while keeping the live daemon process intact.
    spoofDaemonEntryPath(session.userDataDir)

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(
        async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        {
          timeout: 10_000
        }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)
    await waitForPaneCount(secondLaunch.page, 1, 30_000)
    await waitForTerminalOutput(secondLaunch.page, marker, 15_000)

    expect(readDaemonPid(session.userDataDir)).toBe(daemonPidBefore)
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
