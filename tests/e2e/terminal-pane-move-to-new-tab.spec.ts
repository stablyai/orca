import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

type TabStripState = {
  activeTabId: string | null
  tabOrder: string[]
  sourceIndex: number
  sourcePaneCount: number
}

async function readTabStrip(page: Page, sourceTabId: string): Promise<TabStripState> {
  return page.evaluate((sourceTabId) => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const unified = state.unifiedTabsByWorktree[worktreeId] ?? []
    const sourceUnified = unified.find((tab) => tab.entityId === sourceTabId)
    const group = state.groupsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === sourceUnified?.groupId
    )
    const tabOrder = (group?.tabOrder ?? []).map(
      (id) => unified.find((tab) => tab.id === id)?.entityId ?? id
    )
    return {
      activeTabId: state.activeTabId,
      tabOrder,
      sourceIndex: tabOrder.indexOf(sourceTabId),
      sourcePaneCount: window.__paneManagers?.get(sourceTabId)?.getPanes().length ?? 0
    }
  }, sourceTabId)
}

async function openActivePaneContextMenu(page: Page): Promise<void> {
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  const isWindows = await page.evaluate(() => navigator.userAgent.includes('Windows'))
  const point = await page.evaluate(() => {
    const state = window.__store!.getState()
    const pane = window.__paneManagers?.get(state.activeTabId!)?.getActivePane()
    const rect = pane?.container.getBoundingClientRect()
    if (!rect || rect.width <= 0) {
      throw new Error('Active pane is not measurable')
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  const modifiers: ('Control' | 'Meta')[] = isMac || isWindows ? ['Control'] : []
  for (const modifier of modifiers) {
    await page.keyboard.down(modifier)
  }
  await page.mouse.click(point.x, point.y, {
    button: isMac ? 'left' : 'right'
  })
  for (const modifier of modifiers) {
    await page.keyboard.up(modifier)
  }
}

test.describe('terminal pane context menu', () => {
  test('Move Pane to New Tab keeps the live terminal and opens it after the source tab', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const sourceTabId = await orcaPage.evaluate(() => window.__store!.getState().activeTabId!)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const movedPtyId = await waitForActivePanePtyId(orcaPage)
    const before = await readTabStrip(orcaPage, sourceTabId)

    await openActivePaneContextMenu(orcaPage)
    await orcaPage.getByRole('menuitem', { name: 'Move Pane to New Tab' }).click()

    await expect
      .poll(async () => (await readTabStrip(orcaPage, sourceTabId)).sourcePaneCount)
      .toBe(1)
    const after = await readTabStrip(orcaPage, sourceTabId)
    expect(after.tabOrder).toHaveLength(before.tabOrder.length + 1)
    const newTabId = after.tabOrder[after.sourceIndex + 1]
    expect(newTabId).toBeDefined()
    expect(after.activeTabId).toBe(newTabId)

    const newTabPtyIds = await orcaPage.evaluate(
      (tabId) =>
        Object.values(
          window.__store!.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
        ),
      newTabId!
    )
    expect(newTabPtyIds).toEqual([movedPtyId])

    const marker = `MOVED_PANE_ALIVE_${Date.now()}`
    await sendToTerminal(orcaPage, movedPtyId, `echo ${marker}\r`)
    await waitForTerminalOutput(orcaPage, marker, 10_000)
  })
})
