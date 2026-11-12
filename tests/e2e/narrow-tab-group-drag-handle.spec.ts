import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type NarrowLayout = { leftGroupId: string; rightGroupId: string; rightTabId: string }

async function buildNarrowRightColumns(page: Page, worktreeId: string): Promise<NarrowLayout> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setSidebarOpen(false)
    // Open so the right column reserves no window-controls space, which differs per platform.
    state.setRightSidebarOpen(true)
    const leftGroupId = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id]?.[0]?.id
    if (!leftGroupId) {
      throw new Error('No root tab group')
    }
    const middleGroupId = state.createEmptySplitGroup(id, leftGroupId, 'right')
    if (!middleGroupId) {
      throw new Error('Middle split was not created')
    }
    state.createTab(id, middleGroupId, undefined, { activate: true })
    const rightGroupId = state.createEmptySplitGroup(id, middleGroupId, 'right')
    if (!rightGroupId) {
      throw new Error('Right split was not created')
    }
    const rightTab = state.createTab(id, rightGroupId, undefined, { activate: true })
    // Root 80/20, then 60/40 inside it: the right column is under 120px wide.
    state.setTabGroupSplitRatio(id, '', 0.8)
    state.setTabGroupSplitRatio(id, 'second', 0.6)
    const rightTabId =
      window.__store
        ?.getState()
        .unifiedTabsByWorktree[id]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === rightTab.id
        )?.id ?? ''
    return { leftGroupId, rightGroupId, rightTabId }
  }, worktreeId)
}

/** Widest run of strip pixels whose hit target is a tab, i.e. what a pointer can grab. */
async function grabbableTabWidth(page: Page, groupId: string): Promise<number> {
  return page.evaluate((id) => {
    const strip = document.querySelector<HTMLElement>(`[data-tab-group-strip-id="${id}"]`)
    if (!strip) {
      return 0
    }
    const rect = strip.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    let widest = 0
    let run = 0
    for (let x = Math.ceil(rect.left); x < rect.right; x++) {
      const tab = document.elementFromPoint(x, y)?.closest('[data-tab-id]')
      run = tab && strip.contains(tab) ? run + 1 : 0
      widest = Math.max(widest, run)
    }
    return widest
  }, groupId)
}

test('a narrow tab group keeps a grabbable tab and can be dragged into another group', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const layout = await buildNarrowRightColumns(orcaPage, worktreeId)
  const rightStrip = orcaPage.locator(`[data-tab-group-strip-id="${layout.rightGroupId}"]`)
  await expect.poll(async () => (await rightStrip.boundingBox())?.width ?? 0).toBeLessThan(120)

  await expect.poll(() => grabbableTabWidth(orcaPage, layout.rightGroupId)).toBeGreaterThan(24)

  const tab = rightStrip.locator('[data-tab-id]').first()
  const tabBox = await tab.boundingBox()
  const stripBox = await rightStrip.boundingBox()
  const leftBody = await orcaPage
    .locator(`[data-tab-group-body-id="${layout.leftGroupId}"]`)
    .boundingBox()
  if (!tabBox || !stripBox || !leftBody) {
    throw new Error('Drag geometry missing')
  }
  const startX = Math.max(tabBox.x, stripBox.x) + 8
  const startY = tabBox.y + tabBox.height / 2
  await orcaPage.mouse.move(startX, startY)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(startX - 20, startY + 10, { steps: 4 })
  await orcaPage.mouse.move(leftBody.x + leftBody.width / 2, leftBody.y + leftBody.height / 2, {
    steps: 12
  })
  await orcaPage.mouse.up()

  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ id, tabId }) =>
          window.__store?.getState().unifiedTabsByWorktree[id]?.find((t) => t.id === tabId)
            ?.groupId,
        { id: worktreeId, tabId: layout.rightTabId }
      )
    )
    .toBe(layout.leftGroupId)
  // The user sees the tab move: the left strip gains it and the right strip no longer shows it.
  const leftStrip = orcaPage.locator(`[data-tab-group-strip-id="${layout.leftGroupId}"]`)
  await expect(leftStrip.locator('[data-tab-id]')).toHaveCount(2)
  await expect(rightStrip.locator('[data-tab-id]')).toHaveCount(0)
})
