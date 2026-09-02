import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { execInTerminal } from './helpers/terminal-pane-operations'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'

test('presents normal terminal tabs as independent Canvas cards without remounting PTYs', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const seeded = await orcaPage.evaluate((activeWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    const sourceGroupId = state.activeGroupIdByWorktree[activeWorktreeId]
    const originalTerminalTabId = state.activeTabIdByWorktree[activeWorktreeId]
    if (!sourceGroupId || !originalTerminalTabId) {
      throw new Error('active terminal group unavailable')
    }
    const splitGroupId = state.createEmptySplitGroup(activeWorktreeId, sourceGroupId, 'right')
    if (!splitGroupId) {
      throw new Error('could not create second terminal group')
    }
    const terminal = state.createTab(activeWorktreeId, splitGroupId)
    state.setActiveTab(terminal.id)
    state.setActiveTabType('terminal')
    state.focusGroup(activeWorktreeId, splitGroupId)
    return {
      sourceGroupId,
      splitGroupId,
      originalGroupCount:
        window.__store?.getState().groupsByWorktree[activeWorktreeId]?.length ?? 0,
      newTerminalTabId: terminal.id,
      originalTerminalTabId
    }
  }, worktreeId)

  const originalTerminalOverlay = orcaPage.locator(
    `[data-terminal-overlay-tab-id="${seeded.originalTerminalTabId}"]`
  )
  const originalTerminalElement = await originalTerminalOverlay.elementHandle()
  if (!originalTerminalElement) {
    throw new Error('original terminal overlay unavailable')
  }

  await orcaPage.getByRole('button', { name: 'Canvas', exact: true }).press('Enter')
  const canvas = orcaPage.locator('[data-pane-canvas-root="true"]')
  await expect(canvas).toBeVisible()
  await expect(canvas.locator('[data-pane-canvas-terminal-id]')).toHaveCount(2)
  await expect(orcaPage.getByRole('button', { name: 'Splits' })).toBeVisible()
  expect(await originalTerminalElement.evaluate((element) => element.isConnected)).toBe(true)

  const typeIntoCanvasTerminal = async (
    terminalTabId: string,
    markerPrefix: string
  ): Promise<void> => {
    const overlay = orcaPage.locator(`[data-terminal-overlay-tab-id="${terminalTabId}"]`)
    await overlay.locator('.xterm-screen').first().dispatchEvent('pointerdown', { button: 0 })
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (tabId) => window.__store?.getState().activeTabId === tabId,
          terminalTabId
        )
      )
      .toBe(true)
    const markerSuffix = `-${Date.now()}`
    const marker = `${markerPrefix}${markerSuffix}`
    let ptyId: string | null = null
    await expect
      .poll(async () => {
        ptyId = await orcaPage.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container.dataset.ptyId ?? null
        }, terminalTabId)
        return ptyId
      })
      .not.toBeNull()
    if (!ptyId) {
      throw new Error(`Canvas terminal ${terminalTabId} has no active PTY`)
    }
    await execInTerminal(orcaPage, ptyId, splitMarkerEchoCommand(markerPrefix, markerSuffix))
    await expect
      .poll(async () => {
        const content = await orcaPage.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.serializeAddon?.serialize?.() ?? ''
        }, terminalTabId)
        return content.includes(marker)
      })
      .toBe(true)
  }

  await typeIntoCanvasTerminal(seeded.originalTerminalTabId, 'orca-canvas-original')
  await typeIntoCanvasTerminal(seeded.newTerminalTabId, 'orca-canvas-new')

  const newTerminalOverlay = orcaPage.locator(
    `[data-terminal-overlay-tab-id="${seeded.newTerminalTabId}"]`
  )
  await newTerminalOverlay.locator('.xterm-screen').first().click({ button: 'right', force: true })
  await orcaPage.getByRole('menuitem', { name: 'Split Terminal Right' }).click({ force: true })
  await expect(newTerminalOverlay.locator('.xterm')).toHaveCount(2)

  const movedCard = canvas.locator(`[data-pane-canvas-terminal-id="${seeded.newTerminalTabId}"]`)
  const moveHandle = movedCard.getByRole('button', { name: 'Move terminal' })
  const before = await movedCard.boundingBox()
  if (!before) {
    throw new Error('Canvas terminal has no bounds')
  }
  await moveHandle.hover({ force: true })
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(before.x + 120, before.y + 120, { steps: 4 })
  await orcaPage.mouse.up()
  const after = await movedCard.boundingBox()
  expect(after?.x).not.toBe(before.x)

  const resizeHandle = movedCard.locator('[data-pane-canvas-resize-corner="true"]')
  const beforeResize = await movedCard.boundingBox()
  if (!beforeResize) {
    throw new Error('Canvas terminal has no resize bounds')
  }
  await resizeHandle.hover({ force: true })
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    beforeResize.x + beforeResize.width + 96,
    beforeResize.y + beforeResize.height + 80,
    { steps: 4 }
  )
  await orcaPage.mouse.up()
  const afterResize = await movedCard.boundingBox()
  expect(afterResize?.width).toBeGreaterThan(beforeResize.width)
  expect(afterResize?.height).toBeGreaterThan(beforeResize.height)

  const canvasBackground = canvas.locator('[data-pane-canvas-background="true"]')
  await canvasBackground.click({ button: 'right', position: { x: 900, y: 650 }, force: true })
  await orcaPage.getByRole('menuitem', { name: 'New terminal here' }).click({ force: true })
  await expect(canvas.locator('[data-pane-canvas-terminal-id]')).toHaveCount(3)

  const firstCard = canvas.locator('[data-pane-canvas-terminal-id]').first()
  await firstCard.getByRole('button', { name: 'New terminal' }).click({ force: true })
  await expect(canvas.locator('[data-pane-canvas-terminal-id]')).toHaveCount(4)

  const canvasViewport = canvas.locator('[data-pane-canvas-viewport="true"]')
  const overflowCard = canvas.locator('[data-pane-canvas-terminal-id]').last()
  const overflowResizeHandle = overflowCard.getByRole('separator', {
    name: 'Resize terminal height'
  })
  for (let step = 0; step < 10; step += 1) {
    await overflowResizeHandle.press('Shift+ArrowDown')
  }
  await expect
    .poll(() => canvasViewport.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)

  await orcaPage.getByRole('button', { name: 'Splits' }).click({ force: true })
  await expect(canvas).toBeHidden()
  await expect(orcaPage.locator('[data-tab-group-strip-id]')).toHaveCount(seeded.originalGroupCount)
  await expect(
    orcaPage.locator(`[data-tab-group-strip-id="${seeded.sourceGroupId}"] [data-tab-id]`)
  ).toHaveCount(2)
  await expect(
    orcaPage.locator(`[data-tab-group-strip-id="${seeded.splitGroupId}"] [data-tab-id]`)
  ).toHaveCount(2)
  expect(await originalTerminalElement.evaluate((element) => element.isConnected)).toBe(true)

  await orcaPage.getByRole('button', { name: 'Canvas', exact: true }).press('Enter')
  await expect(canvas).toBeVisible()
  const browserTabId = await orcaPage.evaluate(
    ({ activeWorktreeId, targetGroupId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      return state.createBrowserTab(activeWorktreeId, 'about:blank', {
        targetGroupId,
        activate: true
      }).id
    },
    { activeWorktreeId: worktreeId, targetGroupId: seeded.sourceGroupId }
  )
  await expect(canvas).toBeHidden()
  await expect(orcaPage.locator(`[data-tab-id="${browserTabId}"]`)).toBeVisible()
  await orcaPage.evaluate(
    (tabId) => window.__store?.getState().closeBrowserTab(tabId),
    browserTabId
  )
})
