import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'

const WINDOWS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
const ORCHESTRATION_INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration --global'

test.skip(process.env.ORCA_E2E_WEB_CLIENT !== '1', 'requires the paired web client build')
test.skip(process.platform !== 'linux', 'requires a Linux paired execution host')

async function expectHostPlatformCommand(
  app: ElectronApplication,
  offer: RuntimeDesktopPairingOffer,
  show: boolean
): Promise<void> {
  const client = await launchPairedWebClient(app, offer, {
    show,
    userAgent: WINDOWS_USER_AGENT,
    waitForWorkspace: false
  })
  try {
    await client.page.waitForFunction(
      () => {
        const state = window.__store?.getState()
        const environmentId = state?.runtimeEnvironments[0]?.id
        return (
          environmentId !== undefined &&
          state?.runtimeStatusByEnvironmentId.get(environmentId)?.status?.hostPlatform === 'linux'
        )
      },
      null,
      { timeout: 30_000 }
    )
    const platforms = await client.page.evaluate(async () => {
      const state = window.__store?.getState()
      const environmentId = state?.runtimeEnvironments[0]?.id
      return {
        environmentId,
        host: (await window.api.runtime.getStatus()).hostPlatform,
        mirrored: environmentId
          ? state?.runtimeStatusByEnvironmentId.get(environmentId)?.status?.hostPlatform
          : undefined,
        viewer: window.api.platform.get().platform
      }
    })
    expect(platforms).toEqual({
      environmentId: expect.any(String),
      host: 'linux',
      mirrored: 'linux',
      viewer: 'win32'
    })
    await openOrchestrationSettings(client.page)
    await client.page.getByRole('button', { name: 'Copy install command' }).click()
    const command = client.page.getByRole('dialog').locator('p.font-mono')
    await expect(command).toBeVisible()
    await expect(command).toHaveText(ORCHESTRATION_INSTALL_COMMAND)
    await client.page.getByRole('button', { name: 'Done' }).click()

    await client.page.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(
      client.page.getByRole('region', { name: 'Orchestration skill install terminal' })
    ).toBeVisible({ timeout: 30_000 })
    const terminalOwner = await client.page.evaluate(() => {
      const state = window.__store?.getState()
      const tab = Object.values(state?.tabsByWorktree ?? {})
        .flat()
        .find((entry) => entry.customTitle === 'Orchestration setup')
      return {
        runtimeEnvironmentId: tab?.runtimeEnvironmentId ?? null,
        shellOverride: tab?.shellOverride ?? null
      }
    })
    expect(terminalOwner).toEqual({
      runtimeEnvironmentId: platforms.environmentId,
      shellOverride: null
    })
  } finally {
    await client.dispose()
  }
}

async function openOrchestrationSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
  await page.getByRole('button', { name: 'Orchestration', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copy install command' })).toBeVisible()
}

test('uses headed paired host platform for skill commands @headful', async ({
  electronApp,
  orcaPage
}) => {
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  await expectHostPlatformCommand(electronApp, offer, true)
})

test('uses headless paired host platform for skill commands', async () => {
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await expectHostPlatformCommand(host.app, host.offer, false)
  } finally {
    await host.dispose()
  }
})
