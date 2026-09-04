import type { AgentHookEndpoint } from '../../src/shared/agent-hook-endpoint-file'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { worktreeRow } from './worktree-row-locators'

async function emitClaudeHookPayload(
  endpoint: AgentHookEndpoint,
  descriptor: { paneKey: string; worktreeId: string },
  payload: Record<string, unknown>
): Promise<void> {
  const [tabId] = descriptor.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      ...descriptor,
      tabId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  expect(response.status).toBe(204)
}

async function showFullAgentRows(page: Parameters<typeof worktreeRow>[0]): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setAgentActivityDisplayMode('full')
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })
}

test('keeps the Claude parent working after its runtime child stops', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await showFullAgentRows(orcaPage)

  const endpoint = await readHookEndpoint(electronApp)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  expect(descriptor.worktreeId).toBe(worktreeId)

  await emitClaudeHookPayload(endpoint, descriptor, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Continue after the child finishes'
  })
  await emitClaudeHookPayload(endpoint, descriptor, {
    hook_event_name: 'SubagentStart',
    agent_id: 'a1',
    agent_type: 'general-purpose'
  })
  await emitClaudeHookPayload(endpoint, descriptor, {
    hook_event_name: 'Stop',
    background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
  })
  await emitClaudeHookPayload(endpoint, descriptor, {
    hook_event_name: 'SubagentStop',
    agent_id: 'a1'
  })

  const agentRow = worktreeRow(orcaPage, worktreeId)
    .locator('[aria-label="Agents"]')
    .getByText('Continue after the child finishes')
    .locator('xpath=ancestor::div[contains(@class, "group/agent-row")][1]')
  await expect(agentRow).toBeVisible({ timeout: 15_000 })
  await expect(agentRow.getByLabel('Working').first()).toBeVisible()

  await emitClaudeHookPayload(endpoint, descriptor, {
    hook_event_name: 'Stop',
    background_tasks: []
  })
  await expect(agentRow.getByLabel('Done').first()).toBeVisible()
})
