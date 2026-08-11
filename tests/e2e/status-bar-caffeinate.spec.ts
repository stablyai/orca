import { randomUUID } from 'node:crypto'
import type { ElectronApplication } from '@stablyai/playwright-test'
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

test('shows Caffeinate mode and Auto activity in the status bar', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)

  const offStatus = orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' })
  await expect(offStatus).toBeVisible()
  await expect(offStatus).toHaveText('Off')
  await offStatus.click()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^On/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Auto/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Off/ })).toBeVisible()
  const menuProofPath = process.env.ORCA_CAFFEINATE_MENU_PROOF_PATH
  if (menuProofPath) {
    await orcaPage.screenshot({ path: menuProofPath })
  }
  await orcaPage.getByRole('menuitemradio', { name: /^Auto/ }).click()

  const autoInactiveStatus = orcaPage.getByRole('button', {
    name: 'Caffeinate, Auto · Inactive'
  })
  await expect(autoInactiveStatus).toBeVisible()

  const paneKey = `e2e-caffeinate-tab:${randomUUID()}`
  await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')
  const autoActiveStatus = orcaPage.getByRole('button', {
    name: 'Caffeinate, Auto · Active'
  })
  await expect(autoActiveStatus).toBeVisible()
  await expect(autoActiveStatus).toHaveText('Auto')

  const proofPath = process.env.ORCA_CAFFEINATE_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }

  await postCodexHookEvent(electronApp, paneKey, 'Stop')
  await expect(autoInactiveStatus).toBeVisible()
})
