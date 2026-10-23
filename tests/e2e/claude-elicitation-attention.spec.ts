import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import providerPayloads from '../../src/shared/__fixtures__/claude-elicitation-payloads.json'

const form = providerPayloads.find((fixture) => fixture.request.mode === 'form')
const url = providerPayloads.find((fixture) => fixture.request.mode === 'url')
if (!form || !url) {
  throw new Error('Synthetic provider fixtures need form and URL elicitation payloads')
}

async function readStatus(page: Page, paneKey: string) {
  return page.evaluate((key) => window.__store?.getState().agentStatusByPaneKey[key], paneKey)
}

test('HTTP Claude elicitation keeps attention until every request settles and preserves permission waits', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const endpoint = await readHookEndpoint(electronApp)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  await execInTerminal(
    orcaPage,
    await waitForActivePanePtyId(orcaPage),
    `node -e "console.log('synthetic-'+'Claude-hook-ready');setInterval(()=>{},1000)"`
  )
  await waitForTerminalOutput(orcaPage, 'synthetic-Claude-hook-ready', 20_000)
  const identity = await electronApp.evaluate(({ BrowserWindow }) => ({
    cwd: process.cwd(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(identity.cwd).toBe(process.cwd())
  expect(identity.windows.length).toBeGreaterThan(0)
  expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  await testInfo.attach('hidden-instance-identity', {
    body: JSON.stringify(identity, null, 2),
    contentType: 'application/json'
  })
  await orcaPage.getByRole('button', { name: 'View activity', exact: true }).click()
  const activityRow = orcaPage.getByRole('listitem', {
    name: 'Synthetic MCP attention acceptance',
    exact: true
  })

  const events: Record<string, unknown>[] = []
  const send = async (payload: Record<string, unknown>) => {
    const event = { ...payload, session_id: 'e2e-synthetic-elicitation' }
    events.push(event)
    await postClaudeHook(endpoint, pane, event)
  }
  const expectState = async (state: 'working' | 'waiting') => {
    await expect.poll(async () => (await readStatus(orcaPage, pane.paneKey))?.state).toBe(state)
    const label = state === 'waiting' ? 'Needs You: 1' : 'Working: 1'
    await expect(
      orcaPage
        .getByRole('button', { name: /^(View activity|Turn off activity view)$/ })
        .getByLabel(label, { exact: true })
    ).toBeVisible()
    await expect(
      activityRow.getByLabel(state === 'waiting' ? 'Waiting for input' : 'Working', { exact: true })
    ).toBeVisible()
  }
  const capture = async (name: string, state: 'working' | 'waiting') => {
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/)
      await expectState(state)
      await testInfo.attach(`${name}-${theme}-status`, {
        body: JSON.stringify(await readStatus(orcaPage, pane.paneKey), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) })
    }
  }

  await send({ hook_event_name: 'UserPromptSubmit', prompt: 'Synthetic MCP attention acceptance' })
  await send({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'fixture.ts' },
    tool_use_id: 'lead-read'
  })
  await capture('working-before', 'working')
  await send(form.request)
  await capture('elicitation-needs-you', 'waiting')

  const urlRequest = {
    ...url.request,
    mcp_server_name: 'second-synthetic-server',
    elicitation_id: 'second-url-request'
  }
  const urlResult = {
    ...url.result,
    mcp_server_name: 'second-synthetic-server',
    elicitation_id: 'second-url-request'
  }
  await send(urlRequest)
  await expectState('waiting')
  await send(form.result)
  await expectState('waiting')
  await send({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__unrelated__query',
    tool_use_id: 'unrelated-call',
    tool_response: 'synthetic result'
  })
  await expectState('waiting')
  await send({ ...urlResult, elicitation_id: 'stale-url-request' })
  await capture('overlapping-still-needs-you', 'waiting')
  await send(urlResult)
  await capture('all-results-resumed', 'working')

  await send({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'echo synthetic-approval' },
    tool_use_id: 'approval'
  })
  await expectState('waiting')
  const permission = await readStatus(orcaPage, pane.paneKey)
  expect(permission).toMatchObject({ state: 'waiting', toolName: 'Bash' })
  const permissionMetadata = {
    prompt: permission?.prompt,
    toolName: permission?.toolName,
    toolInput: permission?.toolInput,
    mainAgent: permission?.mainAgent
  }
  await capture('permission-before-overlay', 'waiting')
  await send(form.request)
  await expectState('waiting')
  expect(await readStatus(orcaPage, pane.paneKey)).toMatchObject(permissionMetadata)
  await send(form.result)
  await expectState('waiting')
  expect(await readStatus(orcaPage, pane.paneKey)).toMatchObject(permissionMetadata)
  await capture('permission-after-overlay', 'waiting')
  await testInfo.attach('synthetic-http-provider-events', {
    body: JSON.stringify(
      {
        fixtureKind: 'synthetic-provider-payloads-over-real-AgentHookServer-HTTP',
        events,
        permissionMetadata
      },
      null,
      2
    ),
    contentType: 'application/json'
  })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
