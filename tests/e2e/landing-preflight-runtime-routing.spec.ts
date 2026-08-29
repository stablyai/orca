import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { addPairedRuntimeEnvironment } from './helpers/nested-runtime-ssh-client-route'

const missingGitPath = mkdtempSync(path.join(os.tmpdir(), 'orca-preflight-path-'))

test.use({ seedTestRepo: false })
test.describe.configure({ mode: 'serial' })

test.afterAll(() => {
  rmSync(missingGitPath, { recursive: true, force: true })
})

async function setProcessPath(app: ElectronApplication, value: string): Promise<void> {
  await app.evaluate((_electron, nextPath) => {
    process.env.PATH = nextPath
  }, value)
}

async function directGitPreflight(page: Page): Promise<boolean> {
  return page.evaluate(
    async () => (await window.api.preflight.check({ force: true })).git.installed
  )
}

async function expectLandingGitState(
  client: PairedElectronClient,
  installed: boolean
): Promise<void> {
  await expect
    .poll(
      () => client.page.evaluate(() => window.__store?.getState().preflightStatus?.git.installed),
      { timeout: 30_000 }
    )
    .toBe(installed)
  const warning = client.page.getByText('Git is not installed', { exact: true })
  await (installed ? expect(warning).toBeHidden() : expect(warning).toBeVisible())
}

async function selectRuntime(client: PairedElectronClient, environmentId: string): Promise<void> {
  const selected = await client.page.evaluate(async (nextEnvironmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired desktop store is unavailable')
    }
    return store.getState().setActiveRuntimeEnvironmentPreference(nextEnvironmentId)
  }, environmentId)
  expect(selected).toBe(true)
}

async function runRuntimePreflightJourney(
  hubAApp: ElectronApplication,
  hubAPage: Page,
  testInfo: TestInfo,
  headed: boolean
): Promise<void> {
  test.setTimeout(240_000)
  const hubBSession = createRestartSession(testInfo)
  let hubB: Awaited<ReturnType<typeof hubBSession.launch>> | null = null
  let client: PairedElectronClient | null = null
  try {
    await hubAPage.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    hubB = await hubBSession.launch()
    await hubB.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    expect(await directGitPreflight(hubAPage)).toBe(true)
    expect(await directGitPreflight(hubB.page)).toBe(true)

    const offerA = await createRuntimeDesktopPairingOffer(hubAPage)
    client = await launchPairedElectronClient(offerA, testInfo, 'Preflight runtime A')
    await setProcessPath(client.app, missingGitPath)
    expect(await client.app.evaluate(() => process.env.PATH)).toBe(missingGitPath)
    if (headed) {
      await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
      expect(
        await hubAApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
        )
      ).toBe(true)
      expect(
        await hubB.app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
        )
      ).toBe(true)
    }
    expect(await directGitPreflight(client.page)).toBe(false)
    await client.page.evaluate(() => window.dispatchEvent(new Event('focus')))

    const environmentA = client.environmentId
    await expectLandingGitState(client, true)
    const contextA = await client.page.evaluate(
      () => window.__store?.getState().preflightStatusContextKey
    )
    expect(contextA).toContain(`runtime:${environmentA}#`)

    const offerB = await createRuntimeDesktopPairingOffer(hubB.page)
    const environmentB = await addPairedRuntimeEnvironment(client, offerB, 'Preflight runtime B')
    await expectLandingGitState(client, true)
    expect(
      await client.page.evaluate(async (selector) => {
        const response = await window.api.runtimeEnvironments.call({
          selector,
          method: 'preflight.check',
          params: { force: true }
        })
        return response.ok && (response.result as { git: { installed: boolean } }).git.installed
      }, environmentB)
    ).toBe(true)

    await selectRuntime(client, environmentA)
    await expectLandingGitState(client, true)
    const beforeDisconnectContext = await client.page.evaluate(
      () => window.__store?.getState().preflightStatusContextKey
    )
    await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      store.getState().setRuntimeEnvironmentStatus(environmentId, {
        status: null,
        checkedAt: Date.now()
      })
    }, environmentA)
    await expect
      .poll(() => client!.page.evaluate(() => window.__store?.getState().preflightStatus))
      .toBeNull()
    await expect(client.page.getByText('Git is not installed', { exact: true })).toBeHidden()

    await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      const response = await window.api.runtimeEnvironments.connect({
        selector: environmentId,
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      store.getState().setRuntimeEnvironmentStatus(environmentId, {
        status: response.result,
        checkedAt: Date.now()
      })
    }, environmentA)
    await expectLandingGitState(client, true)
    const reconnectedContext = await client.page.evaluate(
      () => window.__store?.getState().preflightStatusContextKey
    )
    expect(reconnectedContext).not.toBe(beforeDisconnectContext)

    await selectRuntime(client, environmentB)
    await expectLandingGitState(client, true)
  } finally {
    await client?.dispose()
    if (hubB) {
      await hubBSession.close(hubB.app)
    }
    await hubBSession.dispose()
  }
}

test('routes landing preflight across runtime switch and reconnect', async ({
  electronApp,
  orcaPage
}, testInfo) => runRuntimePreflightJourney(electronApp, orcaPage, testInfo, false))

test('routes landing preflight across runtime switch and reconnect @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => runRuntimePreflightJourney(electronApp, orcaPage, testInfo, true))
