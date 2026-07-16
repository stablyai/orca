import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalRead
} from '../../src/shared/runtime-types'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

const electronPackageDir = path.join(process.cwd(), 'node_modules', 'electron')
const electronPath = path.join(
  electronPackageDir,
  'dist',
  readFileSync(path.join(electronPackageDir, 'path.txt'), 'utf8').trim()
)

function createLaunchEnv(userDataDir: string): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  return {
    ...cleanEnv,
    NODE_ENV: 'development',
    ORCA_E2E_USER_DATA_DIR: userDataDir,
    ORCA_E2E_HEADLESS: '1',
    // Why: production builds always use the lock; this opt-in makes the dev
    // E2E bundle exercise the same second-instance ownership path.
    ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
  }
}

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

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return await new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

test.describe.configure({ mode: 'serial' })

test('promotes the headless owner without replacing its daemon terminal', async (// oxlint-disable-next-line no-empty-pattern -- This lifecycle test owns both launches and intentionally opts out of the default app fixture.
{}) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-serve-promotion-'))
  const env = createLaunchEnv(userDataDir)
  let serveApp: ElectronApplication | null = null
  let activatingProcess: ChildProcess | null = null

  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )

  try {
    serveApp = await electron.launch({
      args: [...getOrcaElectronLaunchArgs(mainPath, false), '--serve', '--serve-no-pairing'],
      env
    })
    const ownerPid = serveApp.process().pid
    const client = new RuntimeClient(userDataDir, 5_000)

    await expect
      .poll(async () => (await client.getCliStatus()).result.app.desktopWindowStatus, {
        timeout: 60_000,
        message: 'headless serve never became safely openable'
      })
      .toBe('openable')

    const beforeStatus = await client.call<RuntimeStatus>('status.get')
    const daemonPidBefore = readDaemonPid(userDataDir)
    await client.call('repo.add', { path: repoPath, kind: 'git' })
    const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
      worktree: `path:${repoPath}`,
      title: 'Serve promotion continuity'
    })
    const terminal = created.result.terminal
    if (!terminal.ptyId) {
      throw new Error('Headless terminal did not expose its daemon PTY id')
    }

    const beforeMarker = `SERVE_PROMOTION_BEFORE_${Date.now()}`
    await client.call('terminal.send', {
      terminal: terminal.handle,
      text: `echo ${beforeMarker}`,
      enter: true
    })
    await expect
      .poll(
        async () => {
          const response = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: terminal.handle,
            limit: 200
          })
          return response.result.terminal.tail.join('\n')
        },
        { timeout: 15_000 }
      )
      .toContain(beforeMarker)

    activatingProcess = spawn(electronPath, getOrcaElectronLaunchArgs(mainPath, false), {
      env,
      stdio: 'ignore'
    })
    activatingProcess.on('error', (error) => {
      console.error('[e2e] activating process failed to spawn:', error)
    })

    const page = await serveApp.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const promotedPtyId = await discoverActivePtyId(page)
    const afterStatus = await client.call<RuntimeStatus>('status.get')
    expect(serveApp.process().pid).toBe(ownerPid)
    expect(afterStatus.result.runtimeId).toBe(beforeStatus.result.runtimeId)
    expect(afterStatus.result.desktopWindowStatus).toBe('available')
    expect(promotedPtyId).toBe(terminal.ptyId)
    expect(readDaemonPid(userDataDir)).toBe(daemonPidBefore)
    expect(await waitForProcessExit(activatingProcess, 10_000)).toBe(true)
    await waitForTerminalOutput(page, beforeMarker, 30_000)

    const afterMarker = `SERVE_PROMOTION_AFTER_${Date.now()}`
    await execInTerminal(page, promotedPtyId, `echo ${afterMarker}`)
    await waitForTerminalOutput(page, afterMarker, 15_000)
    await expect(page.locator('.xterm:visible').first()).toBeVisible()
    expect(await getTerminalContent(page)).toContain(beforeMarker)
  } finally {
    if (activatingProcess && activatingProcess.exitCode === null) {
      activatingProcess.kill('SIGKILL')
      await waitForProcessExit(activatingProcess, 5_000)
    }
    if (serveApp) {
      await closeElectronAppForE2E(serveApp)
    }
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
