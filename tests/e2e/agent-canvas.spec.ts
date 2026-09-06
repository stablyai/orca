import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('opens a full workspace canvas, drags stable nodes, and restores independent tabs', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    const tab = state.tabsByWorktree[worktreeId]?.[0] ?? state.createTab(worktreeId)
    store.setState({
      settings: {
        ...state.settings,
        experimentalAgentDashboardPopout: false,
        experimentalAgentDashboardMode: 'in-window',
        experimentalAgentDashboardShowIdle: true,
        tabAutoGenerateTitle: false
      }
    })
    state.setAgentStatus(
      `${tab.id}:00000000-0000-4000-8000-000000000001`,
      { state: 'working', prompt: 'Review the authentication flow', agentType: 'codex' },
      'Codex',
      { updatedAt: Date.now(), stateStartedAt: Date.now() },
      { tabId: tab.id, terminalHandle: 'canvas-reviewer', worktreeId }
    )
  }, worktreeId)
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  await expect(orcaPage.locator('[data-agent-canvas]')).toBeVisible()
  const firstCanvasId = await orcaPage
    .locator('[data-workspace-canvas]')
    .getAttribute('data-workspace-canvas')
  const body = await orcaPage.locator('[data-tab-group-body-id]').boundingBox()
  const canvas = await orcaPage.locator('[data-workspace-canvas]').boundingBox()
  expect(canvas!.width).toBeGreaterThan(body!.width - 2)
  expect(canvas!.height).toBeGreaterThan(body!.height - 2)
  await orcaPage.getByRole('button', { name: 'Note', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Node title', exact: true }).fill('Review checklist')
  await orcaPage
    .getByRole('textbox', { name: 'Note content' })
    .fill('Check login, refresh, and logout.')
  const header = orcaPage.locator('[data-canvas-kind="note"] .canvas-node-header')
  const before = await header.boundingBox()
  if (!before) {
    throw new Error('Note header is not visible')
  }
  await orcaPage.mouse.move(before.x + 70, before.y + 15)
  const originalNode = await header.elementHandle()
  await orcaPage.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await orcaPage.mouse.move(before.x + 70 + (340 * step) / 12, before.y + 15 + (85 * step) / 12)
    expect(
      await originalNode!.evaluate(
        (node) => node.isConnected && getComputedStyle(node).visibility !== 'hidden'
      )
    ).toBe(true)
    await expect(header).toBeVisible()
  }
  await orcaPage.mouse.up()
  const after = await header.boundingBox()
  expect(after!.x - before.x).toBeGreaterThan(250)
  await orcaPage.getByRole('button', { name: 'Attach a workspace session', exact: true }).click()
  await orcaPage
    .getByRole('group', { name: 'Attach a workspace session' })
    .getByRole('option')
    .click()
  await expect(orcaPage.locator('.react-flow__node')).toHaveCount(2)
  const note = orcaPage.locator('.react-flow__node').filter({ has: header })
  const output = await note.getByLabel('Drag to connect to an agent').boundingBox()
  const agent = orcaPage
    .locator('.react-flow__node')
    .filter({ has: orcaPage.locator('.canvas-node-header').filter({ hasText: 'codex' }) })
  const agentBox = await agent.boundingBox()
  await orcaPage.mouse.move(output!.x + output!.width / 2, output!.y + output!.height / 2)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(output!.x + 70, output!.y + 40, { steps: 6 })
  await expect(orcaPage.locator('.react-flow__connection-path')).toBeVisible()
  await expect(agent.getByText('Release to connect', { exact: true })).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('canvas-drag-connection.png'),
    animations: 'disabled'
  })
  await orcaPage.mouse.move(agentBox!.x + agentBox!.width / 2, agentBox!.y + agentBox!.height / 2, {
    steps: 12
  })
  await orcaPage.mouse.up()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await expect(agent.locator('[data-canvas-agent-icon="codex"]')).toBeVisible()
  await expect(agent.getByRole('button', { name: 'Attached notes' })).toContainText(
    'Review checklist'
  )
  await expect(agent.getByText('Waiting for the agent terminal to become available.')).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Send context', exact: true })).toHaveCount(0)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await orcaPage.screenshot({
    path: testInfo.outputPath('agent-canvas.png'),
    animations: 'disabled'
  })
  await cdp.detach()
  await note.getByRole('button', { name: 'Choose agent from list', exact: true }).click()
  await expect(orcaPage.getByRole('dialog').getByRole('option')).toContainText('Connected · review')
  await orcaPage.getByRole('dialog').getByRole('combobox').press('ArrowDown')
  await orcaPage.getByRole('dialog').getByRole('combobox').press('Enter')
  await expect(orcaPage.getByLabel('Linked note')).toHaveText('Check login, refresh, and logout.')
  await expect(orcaPage.getByRole('button', { name: 'Send context', exact: true })).toHaveCount(0)
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await orcaPage.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(0)
  const input = await agent.getByLabel('Receive context').boundingBox()
  const sourcePoint = await note.getByLabel('Drag to connect to an agent').boundingBox()
  await orcaPage.mouse.move(
    sourcePoint!.x + sourcePoint!.width / 2,
    sourcePoint!.y + sourcePoint!.height / 2
  )
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(input!.x + input!.width / 2, input!.y + input!.height / 2, {
    steps: 12
  })
  await orcaPage.mouse.up()
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await note.getByRole('button', { name: 'Remove card', exact: true }).click()
  await expect(orcaPage.getByRole('textbox', { name: 'Note content' })).toHaveCount(0)
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'Undo canvas edit', exact: true }).click()
  await expect(orcaPage.getByRole('textbox', { name: 'Note content' })).toHaveValue(
    'Check login, refresh, and logout.'
  )
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  await expect(orcaPage.getByRole('textbox', { name: 'Note content' })).toHaveCount(0)
  await orcaPage
    .locator('[data-tab-group-strip-id]')
    .getByText('Canvas', { exact: true })
    .first()
    .click()
  await expect(orcaPage.locator('[data-workspace-canvas]')).toHaveAttribute(
    'data-workspace-canvas',
    firstCanvasId!
  )
  await expect(orcaPage.getByRole('textbox', { name: 'Note content' })).toHaveValue(
    'Check login, refresh, and logout.'
  )
  await expect(orcaPage.locator('.react-flow__edge')).toHaveCount(1)
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await expect(orcaPage.getByRole('textbox', { name: 'Note content' })).toHaveValue(
    'Check login, refresh, and logout.'
  )
})

test('keeps browser cards mounted while dragging and fits a narrow workspace', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Browser', exact: true }).click()
  await orcaPage
    .getByRole('textbox', { name: 'Browser URL', exact: true })
    .fill('https://example.com/')
  await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  const browserHeader = orcaPage.locator('.canvas-node-header').filter({ hasText: 'Browser page' })
  await expect(browserHeader).toBeInViewport()
  const browserBox = await browserHeader.boundingBox()
  const browserElement = await browserHeader.elementHandle()
  await orcaPage.mouse.move(browserBox!.x + 45, browserBox!.y + 10)
  await orcaPage.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await orcaPage.mouse.move(browserBox!.x + 45 + step * 10, browserBox!.y + 10 - step * 5)
    expect(
      await browserElement!.evaluate(
        (node) => node.isConnected && getComputedStyle(node).visibility !== 'hidden'
      )
    ).toBe(true)
    await expect(browserHeader).toBeVisible()
  }
  await orcaPage.mouse.up()
  await expect(orcaPage.getByRole('textbox', { name: 'Browser URL', exact: true })).toHaveValue(
    'https://example.com/'
  )
  const narrowCdp = await orcaPage.context().newCDPSession(orcaPage)
  await narrowCdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  })
  await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await expect(orcaPage.getByRole('combobox', { name: 'New agent', exact: true })).toBeInViewport()
  await orcaPage.screenshot({ path: testInfo.outputPath('agent-canvas-narrow.png') })
  await narrowCdp.detach()
  const urlInput = orcaPage.getByRole('textbox', { name: 'Browser URL', exact: true })
  await urlInput.press('End')
  await urlInput.press('Backspace')
  await expect(urlInput).toHaveValue('https://example.com')
  await expect(orcaPage.locator('.react-flow__node')).toHaveCount(1)
  await orcaPage.locator('.react-flow__node').focus()
  await orcaPage.locator('.react-flow__node').press('Delete')
  await expect(orcaPage.locator('.react-flow__node')).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'Undo canvas edit', exact: true }).click()
  await expect(urlInput).toHaveValue('https://example.com')
})

test('keeps multiple terminals live while unselected and removes only their cards', async ({
  orcaPage
}, testInfo) => {
  const pageErrors: string[] = []
  orcaPage.on('pageerror', (error) => pageErrors.push(error.message))
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    store.setState({
      detectedAgentIds: ['codex'],
      settings: {
        ...state.settings,
        disabledTuiAgents: [],
        theme: 'dark',
        agentCmdOverrides: {
          ...state.settings?.agentCmdOverrides,
          codex:
            "node -e \"console.log('CANVAS_AGENT_READY');let i=0;setInterval(()=>console.log('CANVAS_TICK_'+(++i)),1000);process.stdin.resume()\""
        },
        agentDefaultArgs: { ...state.settings?.agentDefaultArgs, codex: '' },
        tabAutoGenerateTitle: false
      }
    })
  })
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'New Canvas', exact: true }).click()
  await orcaPage.getByRole('combobox', { name: 'New agent', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Codex', exact: true }).click()
  await expect(orcaPage.locator('[data-workspace-canvas]')).toBeVisible()
  await expect(orcaPage.locator('.canvas-node-header')).toContainText('codex')
  await expect(orcaPage.locator('[data-agent-canvas] .xterm')).toBeVisible({ timeout: 30_000 })
  await expect(orcaPage.locator('[data-agent-canvas] .xterm')).toContainText('CANVAS_AGENT_READY', {
    timeout: 30_000
  })
  const originalTerminal = await orcaPage.locator('[data-agent-canvas] .xterm').elementHandle()
  await orcaPage.getByRole('combobox', { name: 'New agent', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Codex', exact: true }).click()
  await expect(orcaPage.locator('[data-agent-canvas] .xterm')).toHaveCount(2)
  await orcaPage.getByRole('button', { name: 'Note', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await expect(
    orcaPage.locator('.react-flow__node.selected').getByRole('textbox', { name: 'Node title' })
  ).toHaveValue('Untitled note')
  const terminals = orcaPage.locator('[data-agent-canvas] .xterm')
  for (let index = 0; index < 2; index++) {
    await expect(terminals.nth(index)).toBeVisible()
    const ticks = (await terminals.nth(index).innerText()).match(/CANVAS_TICK_(\d+)/g) ?? []
    const tick = Number(ticks.at(-1)?.split('_').at(-1) ?? 0)
    await expect(terminals.nth(index)).toContainText(`CANVAS_TICK_${tick + 1}`, { timeout: 10_000 })
  }
  expect(await originalTerminal!.evaluate((element) => element.isConnected)).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('agent-canvas-live-terminals.png') })
  const firstAgent = orcaPage
    .locator('.react-flow__node')
    .filter({ has: orcaPage.locator('.xterm') })
    .first()
  await firstAgent.getByRole('button', { name: 'Remove card', exact: true }).click()
  await expect(terminals).toHaveCount(1)
  await orcaPage.getByRole('button', { name: 'Undo canvas edit', exact: true }).click()
  await expect(terminals).toHaveCount(2)
  await expect(terminals.first()).toContainText('CANVAS_TICK_', { timeout: 10_000 })
  expect(pageErrors).toEqual([])
})
