/** A second desktop on a fake WSL transport whose "distro" is the HUB's orcad, for WSL host e2e. */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import { createElectronHomeIsolation } from './electron-home-isolation'
import { forwardElectronProcessLogs } from './orca-app'
import { waitForSessionReady } from './store'
import { toRuntimeExecutionHostId } from '../../../src/shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../src/shared/wsl-host-internal-gate'

export const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
export const RUNNING = [{ name: 'Ubuntu', state: 'running', version: 2 }]
export const STOPPED = [{ name: 'Ubuntu', state: 'stopped', version: 2 }]

export async function launchDesktopWithFakeWsl(
  fake: Record<string, unknown>,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  options: { internalGate?: boolean; beforeLaunch?: (userDataDir: string) => void } = {}
): Promise<{
  app: ElectronApplication
  page: Page
  userDataDir: string
  dispose: () => Promise<void>
}> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-host-desktop-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  options.beforeLaunch?.(userDataDir)
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      // WSL hosts exist only behind this internal gate; the gated-off test leaves it closed.
      ...(options.internalGate === false ? {} : { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' }),
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify(fake)
    },
    userDataDir
  })
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADLESS: '1' }
  })
  forwardElectronProcessLogs(app, testInfo)
  const dispose = async (): Promise<void> => {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await waitForSessionReady(page)
    return { app, page, userDataDir, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** A desktop whose fake "distros" (a running Ubuntu, a WSL 1 Legacy) connect to the HUB's code. */
export function launchDesktopWithFakeWslPairing(
  pairingCode: string,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  fakeOverrides: Record<string, unknown> = {},
  options: { internalGate?: boolean; beforeLaunch?: (userDataDir: string) => void } = {}
): ReturnType<typeof launchDesktopWithFakeWsl> {
  return launchDesktopWithFakeWsl(
    {
      distros: [RUNNING[0], { name: 'Legacy', state: 'stopped', version: 1 }],
      pairingCode,
      ...fakeOverrides
    },
    testInfo,
    options
  )
}

export async function setWslHostsEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (experimentalWslHosts) => {
    const settings = await window.api.settings.set({ experimentalWslHosts })
    window.__store?.setState({ settings })
  }, enabled)
}

export function createGitProject(): string {
  // Real path: macOS tmpdir is a /var symlink, and the host lists the repo by its resolved path.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-host-project-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), '# wsl host project\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

/** The fake re-reads this file on every check, so it must never see a half-written one. */
export function writeDistros(distrosFile: string, distros: readonly object[]): void {
  const tmp = `${distrosFile}.tmp`
  writeFileSync(tmp, JSON.stringify(distros))
  renameSync(tmp, distrosFile)
}

export function readDistroState(distrosFile: string): string | undefined {
  const distros: { state?: string }[] = JSON.parse(readFileSync(distrosFile, 'utf8'))
  return distros[0]?.state
}

export function fakeWslConnects(connectLogFile: string): string[] {
  return existsSync(connectLogFile)
    ? readFileSync(connectLogFile, 'utf8').split('\n').filter(Boolean)
    : []
}

/** Focuses the project's worktree on the desktop, which is the act that may boot its distro. */
export async function focusProject(page: Page, repoPath: string): Promise<string | null> {
  return page.evaluate(
    ({ repoPath, hostId }) => {
      const state = window.__store?.getState()
      const repo = state?.repos.find((entry) => entry.path === repoPath)
      const worktree = repo
        ? state?.allWorktrees().find((entry) => entry.repoId === repo.id)
        : undefined
      if (!state || !worktree) {
        return null
      }
      state.setActiveWorktree(worktree.id, hostId)
      return worktree.id
    },
    { repoPath, hostId: toRuntimeExecutionHostId(WSL_ENVIRONMENT_ID) }
  )
}
