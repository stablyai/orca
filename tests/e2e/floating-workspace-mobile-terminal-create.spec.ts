import { _electron as electron, expect, test } from '@stablyai/playwright-test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
test('mobile terminal creation survives a remote floating host selection and a closed panel', async () => {
  test.setTimeout(120_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const profile = mkdtempSync(path.join(tmpdir(), 'orca-mobile-create-repro-'))
  const initial = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(profile, 'orca-data.json'),
    JSON.stringify({
      ...initial,
      settings: {
        ...initial.settings,
        floatingTerminalEnabled: true,
        defaultTuiAgent: 'blank',
        uiLanguage: 'en'
      }
    })
  )
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...inheritedEnv } = process.env
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir: profile
  })
  let app
  try {
    app = await electron.launch({
      args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out/main/index.js'), false),
      env: {
        ...isolation.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_E2E_HEADLESS: '1',
        NODE_ENV: 'development'
      }
    })
    const page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => !!window.api)
    await page.evaluate(
      async (pairingCode) =>
        window.api.runtimeEnvironments.addFromPairingCode({ name: 'Demo Server', pairingCode }),
      host.offer.pairingUrl
    )
    await page.reload()
    await page
      .getByRole('button', { name: /Settings|설정/ })
      .first()
      .waitFor({ timeout: 60000 })
    await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
    const panel = page.locator('[data-floating-terminal-panel]')
    await panel.waitFor()
    await expect
      .poll(
        async () => {
          const response = await new RuntimeClient(profile, 5000, null, null)
            .call<{ graphStatus: string }>('status.get')
            .catch(() => null)
          return response?.result.graphStatus
        },
        { timeout: 30000 }
      )
      .toBe('ready')
    const client = new RuntimeClient(profile, 35000, null, null)
    for (const selectedHost of ['Local', 'Demo Server', 'Remote closed']) {
      if (selectedHost === 'Remote closed') {
        await page.evaluate(() => window.dispatchEvent(new Event('orca-toggle-floating-terminal')))
        await expect(panel).toHaveAttribute('aria-hidden', 'true')
      } else if (selectedHost !== 'Local') {
        await panel.getByRole('button', { name: /Host:|호스트:/ }).click()
        await page.getByRole('menuitemradio', { name: selectedHost, exact: true }).click()
        await expect(panel).toHaveAttribute('data-floating-workspace-id', /runtime:/)
      }

      const reply = await client.call<{ tab: { status: string; terminal: string } }>(
        'session.tabs.createTerminal',
        {
          worktree: 'id:global-floating-terminal',
          command: 'echo ORCA_MOBILE_CREATE',
          activate: false,
          select: false,
          navigation: 'caller'
        }
      )
      expect(reply.result.tab.status).toBe('ready')
      expect(reply.result.tab.terminal).not.toBe('')
    }
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
    )
    expect(windows.every((w) => !w.visible && !w.focused)).toBe(true)
  } finally {
    const keepAlive = setInterval(() => {}, 1000)
    try {
      if (app) {
        await closeElectronAppForE2E(app)
      }
      await cleanupE2EDaemons(profile)
      rmSync(profile, { recursive: true, force: true })
      await host.dispose()
    } finally {
      clearInterval(keepAlive)
    }
  }
})
