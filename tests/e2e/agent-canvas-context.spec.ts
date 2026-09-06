import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

test('connects a note through native context and displays hook delivery without a Send action', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: [],
      experimentalAgentDashboardShowIdle: true,
      tabAutoGenerateTitle: false
    })
  })
  const endpoint = await readHookEndpoint(electronApp)
  const launchToken = randomUUID()
  const sessionId = randomUUID()
  const hook = async () => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.token,
        'X-Orca-Canvas-Context': '1'
      },
      body: JSON.stringify({
        ...pane,
        tabId: pane.paneKey.split(':')[0],
        launchToken,
        env: endpoint.env,
        version: endpoint.version,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionId,
          prompt: 'Review the integration'
        }
      })
    })
    await response.text()
  }
  await hook()
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Note', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Node title', exact: true }).fill('Native reference')
  await orcaPage
    .getByRole('textbox', { name: 'Note content' })
    .fill('Use the existing authentication adapter.')
  await orcaPage.getByRole('button', { name: 'Attach a workspace session', exact: true }).click()
  await orcaPage
    .getByRole('group', { name: 'Attach a workspace session' })
    .getByRole('option')
    .first()
    .click()
  const note = orcaPage.locator('[data-canvas-kind="note"]')
  const agent = orcaPage.locator('[data-canvas-kind="agent"]')
  const source = await note.getByLabel('Drag to connect to an agent').boundingBox()
  const destination = await agent.boundingBox()
  await orcaPage.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    destination!.x + destination!.width / 2,
    destination!.y + destination!.height / 2,
    { steps: 15 }
  )
  await orcaPage.mouse.up()
  await expect(agent.getByText('Context ready · next prompt')).toBeVisible({ timeout: 15_000 })
  await expect(orcaPage.getByRole('button', { name: 'Send context', exact: true })).toHaveCount(0)
  await hook()
  await expect(agent.getByText('Context returned to agent hook')).toBeVisible({ timeout: 15_000 })
  await orcaPage
    .getByRole('textbox', { name: 'Note content' })
    .fill('Use the current authentication adapter.')
  await expect(agent.getByText('Context ready · next prompt')).toBeVisible()
  await hook()
  await expect(agent.getByText('Context returned to agent hook')).toBeVisible({ timeout: 15_000 })
  await orcaPage.screenshot({
    path: testInfo.outputPath('native-canvas-context.png'),
    animations: 'disabled'
  })
  await note.getByRole('button', { name: 'Remove card', exact: true }).click()
  await expect(agent.getByRole('button', { name: 'Attached notes' })).toHaveCount(0)
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(0)
})
