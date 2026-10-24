import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

// Dropping a terminal tab inside another tab's pane edges joins it (drop-tab-into-pane-edge.spec.ts).
// Everything else a tab drag can do over a group must still behave as before.

const TABS = '[data-testid="sortable-tab"]:visible'
const BODIES = '[data-tab-group-body-id]:visible'
const JOIN_OVERLAY = '[data-leaf-drop-overlay]'

async function openTerminalTabs(page: Page, count: number): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.evaluate((count) => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    for (let index = (state.tabsByWorktree[worktreeId] ?? []).length; index < count; index++) {
      state.createTab(worktreeId)
    }
  }, count)
  await expect(page.locator(TABS)).toHaveCount(count)
}

async function readTerminalTabs(page: Page): Promise<{ ids: string[]; rootTypes: string[] }> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const ids = (state.tabsByWorktree[state.activeWorktreeId!] ?? []).map((tab) => tab.id).sort()
    return {
      ids,
      rootTypes: ids.map((id) => state.terminalLayoutsByTabId[id]?.root?.type ?? 'none')
    }
  })
}

async function readStripOrder(page: Page): Promise<string[]> {
  return page
    .locator(TABS)
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id') ?? ''))
}

/** Drags the first visible tab to `target` and drops it, returning what the overlay said on the way. */
async function dragFirstTabTo(
  page: Page,
  target: { x: number; y: number },
  afterMove?: () => Promise<void>
): Promise<void> {
  const tab = (await page.locator(TABS).first().boundingBox())!
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 15 })
  await afterMove?.()
  await page.mouse.up()
}

test('a tab dropped on the right of the strip reorders and never offers a join', async ({
  orcaPage
}) => {
  await openTerminalTabs(orcaPage, 3)
  const before = await readStripOrder(orcaPage)
  const last = (await orcaPage.locator(TABS).last().boundingBox())!

  await dragFirstTabTo(
    orcaPage,
    { x: last.x + last.width * 0.9, y: last.y + last.height / 2 },
    async () => {
      await expect(orcaPage.locator(JOIN_OVERLAY)).toHaveCount(0)
    }
  )

  await expect.poll(() => readStripOrder(orcaPage)).toEqual([before[1], before[2], before[0]])
  await expect(orcaPage.locator(BODIES)).toHaveCount(1)
})

test('the outer band opens a new column, then the body center merges the tab back, never joining', async ({
  orcaPage
}) => {
  await openTerminalTabs(orcaPage, 2)
  const tabsBefore = await readTerminalTabs(orcaPage)
  const bodies = orcaPage.locator(BODIES)
  const panel = (await bodies.boundingBox())!

  await dragFirstTabTo(
    orcaPage,
    { x: panel.x + panel.width - 30, y: panel.y + panel.height / 2 },
    async () => {
      await expect(orcaPage.getByText('New column', { exact: true })).toBeVisible()
      await expect(orcaPage.locator(JOIN_OVERLAY)).toHaveCount(0)
    }
  )
  await expect(bodies).toHaveCount(2)
  expect(await readTerminalTabs(orcaPage)).toEqual(tabsBefore)

  const right = (await bodies.last().boundingBox())!
  await dragFirstTabTo(
    orcaPage,
    { x: right.x + right.width / 2, y: right.y + right.height / 2 },
    async () => {
      await expect(orcaPage.locator(JOIN_OVERLAY)).toHaveCount(0)
    }
  )
  await expect(bodies).toHaveCount(1)
  await expect(orcaPage.locator(TABS)).toHaveCount(2)
  expect(await readTerminalTabs(orcaPage)).toEqual(tabsBefore)
})
