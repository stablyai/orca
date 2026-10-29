import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { RuntimeClientError } from '../../src/cli/runtime/types'

test.skip(process.env.ORCA_E2E_WEB_CLIENT !== '1', 'Requires the bundled connected-client UI')

test('serve Quit closes retained desktop and worker windows while the runtime stays alive', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'orca-multi-window-serve-'))
  writeFileSync(
    path.join(profile, 'orca-data.json'),
    JSON.stringify(getE2ECompletedOnboardingProfile())
  )
  const { ELECTRON_RUN_AS_NODE: unused, ...inheritedEnv } = process.env
  void unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: { ORCA_BACKGROUND_LAUNCH: '1', ORCA_E2E_HEADLESS: '1' },
    userDataDir: profile
  })
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
      ...getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out/main/index.js'), false),
      '--serve',
      '--serve-no-pairing'
    ],
    env: isolation.env
  })
  try {
    const client = new RuntimeClient(profile, 5_000)
    await expect
      .poll(
        async () => {
          try {
            return (await client.getCliStatus()).result.runtime.state
          } catch (error) {
            if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
              return 'starting'
            }
            throw error
          }
        },
        { timeout: 60_000 }
      )
      .toBe('ready')
    await app.evaluate(({ app }) => app.emit('activate'))
    const main = await app.firstWindow()
    await main.waitForFunction(() => Boolean(window.api?.settings))
    await main.evaluate(() => window.api.settings.set({ experimentalMultiWindow: true }))
    const workers: Page[] = []
    for (let index = 0; index < 2; index++) {
      const opened = app.waitForEvent('window')
      await app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('new-window')
        if (!item) {
          throw new Error('New Window is unavailable')
        }
        item.click()
      })
      const worker = await opened
      await expect(worker.locator('[data-worktree-sidebar]')).toBeVisible()
      workers.push(worker)
    }
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.id)
    )
    const host = await app.browserWindow(main)
    await host.evaluate((window) => window.close())
    expect(await host.evaluate((window) => window.isDestroyed())).toBe(false)
    const quit = async (): Promise<void> =>
      app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((menu) => menu.submenu?.items ?? [])
          .find((item) => item.label === 'Exit' || item.label.startsWith('Quit Orca'))
        if (!item) {
          throw new Error('User Quit is unavailable')
        }
        item.click()
      })
    await workers[0].evaluate(() => {
      window.onbeforeunload = (event) => {
        event.preventDefault()
        event.returnValue = ''
      }
    })
    await quit()
    await expect.poll(() => workers[1].isClosed()).toBe(true)
    expect(workers[0].isClosed()).toBe(false)
    expect(await host.evaluate((window) => window.isDestroyed())).toBe(false)
    expect((await client.getCliStatus()).result.runtime.state).toBe('ready')
    await workers[0].evaluate(() => {
      window.onbeforeunload = null
    })
    await quit()
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }, ids) => ids.every((id) => !BrowserWindow.fromId(id)),
          windows
        )
      )
      .toBe(true)
    expect(app.process().exitCode).toBeNull()
    expect((await client.getCliStatus()).result.runtime.state).toBe('ready')
  } finally {
    await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: profile })
    rmSync(profile, { recursive: true, force: true })
  }
})
