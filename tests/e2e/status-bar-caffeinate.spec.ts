import { randomUUID } from 'node:crypto'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/mcode-app'
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
      'X-MCode-Agent-Hook-Token': endpoint.token
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

test('shows Caffeinate mode and Agent activity in the status bar', async ({
  electronApp,
  mcodePage
}) => {
  await waitForSessionReady(mcodePage)

  const offStatus = mcodePage.getByRole('button', { name: 'Caffeinate, Off · Inactive' })
  await expect(offStatus).toBeVisible()
  await expect(offStatus).toHaveText('Off')
  await offStatus.click()
  await expect(mcodePage.getByRole('menuitemradio', { name: /^On/ })).toBeVisible()
  await expect(mcodePage.getByRole('menuitemradio', { name: /^Agent/ })).toBeVisible()
  await expect(mcodePage.getByRole('menuitemradio', { name: /^Off/ })).toBeVisible()
  const menuProofPath = process.env.MCODE_CAFFEINATE_MENU_PROOF_PATH
  if (menuProofPath) {
    await mcodePage.screenshot({ path: menuProofPath })
  }
  await mcodePage.getByRole('menuitemradio', { name: /^Agent/ }).click()

  const agentInactiveStatus = mcodePage.getByRole('button', {
    name: 'Caffeinate, Agent · Inactive'
  })
  await expect(agentInactiveStatus).toBeVisible()

  const paneKey = `e2e-caffeinate-tab:${randomUUID()}`
  await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')
  const agentActiveStatus = mcodePage.getByRole('button', {
    name: 'Caffeinate, Agent · Active'
  })
  await expect(agentActiveStatus).toBeVisible()
  await expect(agentActiveStatus).toHaveText('Agent')

  const proofPath = process.env.MCODE_CAFFEINATE_PROOF_PATH
  if (proofPath) {
    await mcodePage.screenshot({ path: proofPath })
  }

  await postCodexHookEvent(electronApp, paneKey, 'Stop')
  await expect(agentInactiveStatus).toBeVisible()
})
