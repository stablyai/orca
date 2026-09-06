import { randomUUID } from 'node:crypto'
import { runProcess } from '../../src/shared/child-process/run-process'
import { resolveManagedOrcaCliCommand } from '../../src/main/cli/managed-orca-cli-command'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('connected agents exchange real CLI messages and replies with visible history and pause', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: [],
      experimentalAgentDashboardShowIdle: true,
      tabAutoGenerateTitle: false
    })
  })
  await configureGoldenStubAgent(orcaPage)
  await launchGoldenStubAgentFromNewTab(orcaPage)
  const first = await waitForActivePaneHookDescriptor(orcaPage)
  await launchGoldenStubAgentFromNewTab(orcaPage)
  const second = await waitForActivePaneHookDescriptor(orcaPage)
  expect(second.paneKey).not.toBe(first.paneKey)
  const endpoint = await readHookEndpoint(electronApp)
  const agents = []
  for (const pane of [first, second]) {
    const launchToken = await orcaPage.evaluate(
      (key) => window.__store!.getState().agentLaunchConfigByPaneKey[key]?.identity.launchToken,
      pane.paneKey
    )
    if (!launchToken) {
      throw new Error('Managed terminal launch identity missing')
    }
    agents.push({ ...pane, launchToken, sessionId: randomUUID() })
  }
  for (const agent of agents) {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.token,
        'X-Orca-Canvas-Context': '1'
      },
      body: JSON.stringify({
        ...agent,
        tabId: agent.paneKey.split(':')[0],
        env: endpoint.env,
        version: endpoint.version,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: agent.sessionId,
          prompt: 'Review the API contract'
        }
      })
    })
    expect(response.ok).toBe(true)
    await response.text()
  }
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  for (let index = 0; index < 2; index++) {
    await orcaPage.getByRole('button', { name: 'Attach a workspace session', exact: true }).click()
    await orcaPage
      .getByRole('group', { name: 'Attach a workspace session' })
      .getByRole('option')
      .first()
      .click()
  }
  await expect(orcaPage.locator('[data-canvas-kind="agent"]')).toHaveCount(2)
  await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  const cards = orcaPage.locator('[data-canvas-kind="agent"]')
  let previousBounds = ''
  await expect
    .poll(async () => {
      const bounds = JSON.stringify(await cards.nth(0).boundingBox())
      const stable = bounds === previousBounds
      previousBounds = bounds
      return stable
    })
    .toBe(true)
  const source = await cards.nth(0).getByLabel('Drag to connect to an agent').boundingBox()
  const destinationId = await cards.nth(1).locator('..').getAttribute('data-id')
  await cards.nth(0).getByLabel('Drag to connect to an agent').hover()
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(source!.x + source!.width + 40, source!.y + source!.height / 2, {
    steps: 5
  })
  await expect(orcaPage.locator('.react-flow__connection-path')).toBeVisible()
  const destinationCard = orcaPage.locator(`.react-flow__node[data-id="${destinationId}"]`)
  await expect(destinationCard.getByText('Release to connect', { exact: true })).toBeVisible()
  const destination = await destinationCard.boundingBox()
  await orcaPage.mouse.move(
    destination!.x + destination!.width / 2,
    destination!.y + destination!.height / 2,
    { steps: 15 }
  )
  await orcaPage.mouse.up()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await expect(
    orcaPage.getByRole('button', { name: 'Pause collaboration', exact: true })
  ).toBeVisible()
  await orcaPage.locator('.canvas-link-control').click()
  await expect(orcaPage.getByRole('complementary', { name: 'Agent collaboration' })).toBeVisible()
  await expect(orcaPage.getByText('Connected · agents can exchange messages')).toBeVisible({
    timeout: 15_000
  })
  await expect(orcaPage.getByRole('button', { name: 'Send context', exact: true })).toHaveCount(0)
  const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const command = resolveManagedOrcaCliCommand({ isPackaged: false, userDataPath })
  if (!command) {
    throw new Error('Managed Orca CLI missing')
  }
  const runCli = async (index: number, args: string[]) => {
    const result = await runProcess({
      program: command,
      args: [...args, '--json'],
      timeoutMs: 30_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
        ),
        ORCA_USER_DATA_PATH: userDataPath,
        ORCA_PANE_KEY: agents[index].paneKey,
        ORCA_AGENT_LAUNCH_TOKEN: agents[index].launchToken
      }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout)
    }
    return JSON.parse(result.stdout).result
  }
  const { canvases } = await runCli(0, ['canvas', 'peers'])
  const canvas = canvases.find((item: { peers: unknown[] }) => item.peers.length)
  expect(canvas).toBeTruthy()
  const { message } = await runCli(0, [
    'canvas',
    'send',
    '--canvas',
    canvas.canvasId,
    '--to',
    canvas.peers[0].id,
    '--kind',
    'question',
    '--body',
    'Which endpoint should the browser use?'
  ])
  const history = orcaPage.getByLabel('Message history', { exact: true })
  await expect(history).toContainText('Which endpoint should the browser use?')
  await expect(history).toContainText('Queued')
  await runCli(1, ['canvas', 'inbox', '--canvas', canvas.canvasId])
  await expect(history).toContainText('Retrieved by agent')
  await runCli(1, [
    'canvas',
    'send',
    '--canvas',
    canvas.canvasId,
    '--to',
    canvas.self,
    '--reply-to',
    message.id,
    '--body',
    'Use GET /items with the existing adapter.'
  ])
  await expect(history).toContainText('Use GET /items with the existing adapter.')
  await expect(history).toContainText('Replied')
  await orcaPage.screenshot({
    path: testInfo.outputPath('canvas-message-history.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'Close connection details', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Pause collaboration', exact: true }).click()
  await expect(
    orcaPage.getByRole('button', { name: 'Resume collaboration', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await orcaPage.locator('.canvas-link-control').click()
  await expect(orcaPage.getByText('Collaboration paused · messages stay queued')).toBeVisible()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await expect(orcaPage.getByRole('button', { name: 'Disconnect', exact: true })).toBeInViewport()
  await orcaPage.screenshot({
    path: testInfo.outputPath('canvas-message-history-narrow.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(0)
  await cdp.detach()
})
