import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { test, expect, forwardElectronProcessLogs } from './helpers/orca-app'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { assertElectronResolvedIsolatedHome } from './helpers/electron-home-isolation'
import { isolatedServeProfile } from './helpers/orca-serve-cli-host'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { RuntimeClientError } from '../../src/cli/runtime/types'

// Regression: a profile-less Windows session (e.g. `orca serve` over SSH) has no roaming AppData,
// and Electron 43 crashed natively resolving userData before Orca pinned it.
test('orca serve starts on Windows when the home has no AppData folder', async (// oxlint-disable-next-line no-empty-pattern -- This spec owns its launch and opts out of the default app fixture.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Windows AppData resolution only')

  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-missing-appdata-'))
  const missingAppData = path.join(userDataDir, 'absent', 'AppData', 'Roaming')
  const isolation = isolatedServeProfile(userDataDir, {
    NODE_ENV: 'development',
    ORCA_E2E_HEADLESS: '1',
    APPDATA: missingAppData
  })
  rmSync(path.join(isolation.isolatedHome, 'AppData'), { recursive: true, force: true })
  expect(existsSync(missingAppData)).toBe(false)

  let serveApp: ElectronApplication | null = null
  try {
    serveApp = await electron.launch({
      args: [...getOrcaElectronLaunchArgs(mainPath, false), '--serve', '--serve-no-pairing'],
      env: Object.fromEntries(
        Object.entries(isolation.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
    })
    forwardElectronProcessLogs(serveApp, testInfo)
    const paths = await serveApp.evaluate(({ app }) => ({
      home: app.getPath('home'),
      appData: app.getPath('appData'),
      userData: app.getPath('userData')
    }))
    assertElectronResolvedIsolatedHome(paths.home, isolation)
    // Why realpath: tmpdir can be an 8.3 short-name alias of the path Electron reports.
    expect(realpathSync.native(paths.userData).toLowerCase()).toBe(
      realpathSync.native(userDataDir).toLowerCase()
    )
    // Records whether Windows reported AppData or Orca fell back to the environment.
    testInfo.annotations.push({
      type: 'appData',
      description: `${paths.appData === missingAppData ? 'env fallback' : 'native'}: ${paths.appData}`
    })

    const client = new RuntimeClient(userDataDir, 5_000)
    await expect
      .poll(
        async () => {
          try {
            return (await client.getCliStatus()).result.app.desktopWindowStatus
          } catch (error) {
            if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
              return 'starting'
            }
            throw error
          }
        },
        { timeout: 60_000, message: 'orca serve never became ready without AppData' }
      )
      .toBe('openable')
  } finally {
    if (serveApp) {
      await closeElectronAppForE2E(serveApp)
    }
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
