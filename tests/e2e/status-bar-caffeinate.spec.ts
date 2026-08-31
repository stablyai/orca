import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { waitForStartupFocusToSettle } from './helpers/status-bar-menu'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

async function readAmphetamineInstalled(page: Page): Promise<boolean> {
  await page.evaluate(() => window.api.agentAwake.probeAmphetamine())
  const installed = await page.evaluate(async () => {
    const status = await window.api.agentAwake.getStatus()
    return status.amphetamineInstalled
  })
  if (typeof installed !== 'boolean') {
    throw new Error('Amphetamine installation status remained unknown after an explicit probe')
  }
  return installed
}

async function selectInactiveAmphetamineIntegration(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({
      computerAwakeMacosEngine: 'amphetamine',
      computerAwakeMode: 'off',
      keepComputerAwakeWhileAgentsRun: false
    })
    window.__store?.setState({ settings: settings as GlobalSettings })
  })
}

async function postCodexHookEvent(
  electronApp: ElectronApplication,
  paneKey: string,
  eventName: 'UserPromptSubmit' | 'Stop'
): Promise<void> {
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'e2e-caffeinate-tab',
      worktreeId: 'e2e-caffeinate-worktree',
      env: endpoint.env,
      version: endpoint.version,
      payload: { hook_event_name: eventName, prompt: 'e2e caffeinate prompt' }
    })
  })
  expect(response.status).toBe(204)
}

test('shows the effective Caffeinate identity and Agent activity in the status bar', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)

  await waitForStartupFocusToSettle(orcaPage)
  const offStatus = orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' })
  await expect(offStatus).toBeVisible()
  await expect(offStatus).toHaveText('Off')
  await offStatus.click()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^On/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Agent/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Off/ })).toBeVisible()
  const effectiveStatus = orcaPage
    .getByRole('menu')
    .locator('[data-slot="dropdown-menu-label"]')
    .filter({ hasText: 'Keep awake' })
  await expect(effectiveStatus).toContainText('Caffeinate')
  const menuProofPath = process.env.ORCA_CAFFEINATE_MENU_PROOF_PATH
  if (menuProofPath) {
    await orcaPage.getByRole('menu').screenshot({ path: menuProofPath, animations: 'disabled' })
  }
  await orcaPage.getByRole('menuitemradio', { name: /^Agent/ }).click()

  const agentInactiveStatus = orcaPage.getByRole('button', {
    name: 'Keep computer awake, Agent · Inactive'
  })
  await expect(agentInactiveStatus).toBeVisible()

  const paneKey = `e2e-caffeinate-tab:${randomUUID()}`
  await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')
  const agentActiveStatus = orcaPage.getByRole('button', {
    name: 'Keep computer awake, Agent · Active'
  })
  await expect(agentActiveStatus).toBeVisible()
  await expect(agentActiveStatus).toHaveText('Agent')

  const proofPath = process.env.ORCA_CAFFEINATE_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }

  await postCodexHookEvent(electronApp, paneKey, 'Stop')
  await expect(agentInactiveStatus).toBeVisible()
})

test.describe('macOS Amphetamine status-bar integration', () => {
  test.skip(process.platform !== 'darwin', 'the Amphetamine integration is macOS only')

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('shows read-only choices and visible inline explanations', async ({ orcaPage }) => {
    const installed = await readAmphetamineInstalled(orcaPage)
    await waitForStartupFocusToSettle(orcaPage)
    await orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' }).click()

    const menu = orcaPage.getByRole('menu')
    const engineMenu = menu.getByRole('menuitem', { name: /Caffeinate/ })
    const beforeProofPath = process.env.ORCA_AMPHETAMINE_MENU_BEFORE_PROOF_PATH
    if (beforeProofPath) {
      await orcaPage.screenshot({ path: beforeProofPath, animations: 'disabled' })
    }
    await engineMenu.hover()
    const enginePicker = orcaPage.getByRole('menu').filter({ hasText: 'Amphetamine integration' })
    const builtInOnly = enginePicker.getByRole('menuitemradio', { name: 'Built-in only' })
    const addAmphetamine = enginePicker.getByRole('menuitemradio', {
      name: 'Amphetamine (read-only)'
    })
    await expect(enginePicker.getByText('Amphetamine integration', { exact: true })).toBeVisible()
    await expect(builtInOnly).toHaveAttribute('aria-checked', 'true')
    await expect(addAmphetamine).toBeVisible()
    await expect(
      enginePicker.getByText('When keep-awake is active, Orca uses Caffeinate.', { exact: true })
    ).toBeVisible()
    await expect(
      enginePicker.getByText(/Orca still uses Caffeinate; this only observes a session/)
    ).toBeVisible()
    await expect(enginePicker).toContainText(
      'Closed-display behavior depends on Amphetamine and macOS settings.'
    )

    if (installed) {
      await expect(addAmphetamine).toBeEnabled()
      await addAmphetamine.click()
      await expect(addAmphetamine).toHaveAttribute('aria-checked', 'true')
      await expect(enginePicker).toBeVisible()
      await expect
        .poll(
          async () =>
            (await orcaPage.evaluate(() => window.api.settings.get())).computerAwakeMacosEngine,
          { timeout: 5_000, message: 'Amphetamine integration choice did not persist' }
        )
        .toBe('amphetamine')
    } else {
      await expect(addAmphetamine).toBeDisabled()
      await expect(
        enginePicker.getByText(/Install Amphetamine to let Orca observe a session/)
      ).toBeVisible()
      // Avoid opening the real App Store during E2E.
      await expect(enginePicker.getByRole('menuitem', { name: 'Get Amphetamine…' })).toBeVisible()
      await expect(enginePicker.getByRole('menuitem', { name: 'Check again' })).toBeVisible()
    }

    const proofPath = process.env.ORCA_AMPHETAMINE_MENU_PROOF_PATH
    if (proofPath) {
      await orcaPage.screenshot({ path: proofPath, animations: 'disabled' })
    }
  })

  test('shows Caffeinate as the effective assertion while the integration is inactive', async ({
    orcaPage
  }) => {
    await selectInactiveAmphetamineIntegration(orcaPage)
    await expect
      .poll(async () => orcaPage.evaluate(() => window.api.agentAwake.getStatus()), {
        timeout: 5_000,
        message: 'Amphetamine preference did not reach the awake service'
      })
      .toEqual(
        expect.objectContaining({
          macosEngine: 'amphetamine',
          amphetamineActive: false
        })
      )

    await waitForStartupFocusToSettle(orcaPage)
    const trigger = orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' })
    await expect(trigger).toBeVisible()
    await trigger.click()

    const menu = orcaPage.getByRole('menu')
    const effectiveStatus = menu
      .locator('[data-slot="dropdown-menu-label"]')
      .filter({ hasText: 'Keep awake' })
    await expect(effectiveStatus).toContainText('Caffeinate')
    await menu.getByRole('menuitem', { name: /Caffeinate/ }).hover()
    const enginePicker = orcaPage.getByRole('menu').filter({ hasText: 'Amphetamine integration' })
    await expect(
      enginePicker.getByRole('menuitemradio', { name: 'Amphetamine (read-only)' })
    ).toHaveAttribute('aria-checked', 'true')
  })
})
