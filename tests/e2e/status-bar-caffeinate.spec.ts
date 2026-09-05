import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

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

// Why: only 'zai' is checked, so every usage meter in the status bar belongs to
// the synthetic snapshot and percentage assertions cannot collide with real CLIs.
async function seedZaiUsage(orcaPage: Page): Promise<void> {
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.setState({
      statusBarItems: ['zai'],
      statusBarUsageMode: 'verbose',
      usagePercentageDisplay: 'used',
      rateLimits: {
        ...store.getState().rateLimits,
        zai: {
          provider: 'zai',
          session: {
            usedPercent: 37,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: null,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        },
        zaiAuthConfigured: true
      }
    })
  })
}

test('shows keep-awake mode and Agent activity in the status bar', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)

  const offStatus = orcaPage.getByRole('button', {
    name: 'Keep computer awake, Off · Inactive'
  })
  await expect(offStatus).toBeVisible()
  await expect(offStatus).toHaveText('Off')
  await offStatus.click()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^On/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Agent/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Off/ })).toBeVisible()
  const menuProofPath = process.env.ORCA_CAFFEINATE_MENU_PROOF_PATH
  if (menuProofPath) {
    await orcaPage.screenshot({ path: menuProofPath })
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

test('renders synthetic Z.AI usage across status bar modes', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await seedZaiUsage(orcaPage)

  const usageTrigger = orcaPage.getByRole('button', { name: 'Usage', exact: true })

  // Normal: verbose density with used-percentage display.
  await expect(usageTrigger).toBeVisible()
  await expect(usageTrigger).toContainText('37%')

  // Remaining: the same window flips to % remaining.
  await orcaPage.evaluate(() => {
    window.__store?.setState({ usagePercentageDisplay: 'remaining' })
  })
  await expect(usageTrigger).toContainText('63%')
  await expect(usageTrigger).not.toContainText('37%')
  await orcaPage.evaluate(() => {
    window.__store?.setState({ usagePercentageDisplay: 'used' })
  })
  await expect(usageTrigger).toContainText('37%')

  // Detailed: the roster popover lists the Z.AI row with both its identity and windows.
  await usageTrigger.click()
  const rosterRow = orcaPage.locator('[data-usage-mode="verbose"]', { hasText: 'Z.AI' })
  await expect(rosterRow).toBeVisible()

  // Compact: roster density collapses to the tightest window only.
  await orcaPage.evaluate(() => {
    window.__store?.setState({ statusBarUsageMode: 'compact' })
  })
  await expect(orcaPage.locator('[data-usage-mode="compact"]', { hasText: 'Z.AI' })).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect(usageTrigger).toContainText('37%')

  // Icon-only: a narrow window swaps meters for the single-letter Z badge.
  await orcaPage.setViewportSize({ width: 420, height: 800 })
  const zaiBadge = orcaPage.getByTitle('Z.AI')
  await expect(zaiBadge).toBeVisible()
  await expect(zaiBadge).toContainText('Z')
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await expect(usageTrigger).toContainText('37%')

  // Toggle: the visibility menu item must be focused explicitly before Enter —
  // Radix checkbox items do not reliably activate from a pointerless click.
  await usageTrigger.click({ button: 'right' })
  const zaiToggle = orcaPage.getByRole('menuitemcheckbox', { name: 'Z.AI Usage' })
  await expect(zaiToggle).toBeVisible()
  await expect(zaiToggle).toBeChecked()
  await zaiToggle.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(zaiToggle).not.toBeChecked()
  await orcaPage.keyboard.press('Escape')
  // Why: zai was the only checked provider, so unchecking it unmounts the usage trigger entirely.
  await expect(usageTrigger).toBeHidden()
})
