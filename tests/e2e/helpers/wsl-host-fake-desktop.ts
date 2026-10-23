/**
 * A second desktop with a fake WSL transport (`ORCA_E2E_FAKE_WSL_HOSTS`): no wsl.exe in CI. Its
 * "distros" connect straight to the pairing code given, which a HUB fixture stands behind.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../src/shared/wsl-host-internal-gate'

export async function launchDesktopWithFakeWsl(
  pairingCode: string,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  fakeOverrides: Record<string, unknown> = {},
  options: { internalGate?: boolean; beforeLaunch?: (userDataDir: string) => void } = {}
): Promise<{
  app: ElectronApplication
  page: Page
  userDataDir: string
  dispose: () => Promise<void>
}> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-desktop-'))
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
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify({
        distros: [
          { name: 'Ubuntu', state: 'running', version: 2 },
          { name: 'Legacy', state: 'stopped', version: 1 }
        ],
        pairingCode,
        ...fakeOverrides
      })
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

/** Every distro the fake connector was asked to start, from the log file it appends to. */
export function fakeWslConnects(connectLogFile: string): string[] {
  return existsSync(connectLogFile)
    ? readFileSync(connectLogFile, 'utf8').split('\n').filter(Boolean)
    : []
}

export async function setWslHostsEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (experimentalWslHosts) => {
    const settings = await window.api.settings.set({ experimentalWslHosts })
    window.__store?.setState({ settings })
  }, enabled)
}
