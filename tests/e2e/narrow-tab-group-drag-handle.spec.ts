import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type NarrowLayout = { leftGroupId: string; rightGroupId: string; rightTabId: string }

async function buildThreeColumns(
  page: Page,
  worktreeId: string,
  rightSidebarOpen = true
): Promise<NarrowLayout> {
  return page.evaluate(
    ({ id, rightSidebarOpen }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      state.setSidebarOpen(false)
      // Open by default so the right column reserves no window-controls space, which differs per platform.
      state.setRightSidebarOpen(rightSidebarOpen)
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
      const rightTabId =
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[id]?.find(
            (tab) => tab.contentType === 'terminal' && tab.entityId === rightTab.id
          )?.id ?? ''
      return { leftGroupId, rightGroupId, rightTabId }
    },
    { id: worktreeId, rightSidebarOpen }
  )
}

async function narrowRightColumns(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    // Root 80/20, then 45/55 inside it: the right column is about 98px wide, under 120px.
    state?.setTabGroupSplitRatio(id, '', 0.8)
    state?.setTabGroupSplitRatio(id, 'second', 0.45)
  }, worktreeId)
}

/** Widest run of strip pixels where a press starts a tab drag: a tab, but not its close button or other inner controls. */
async function draggableTabRun(page: Page, groupId: string): Promise<{ width: number; x: number }> {
  return page.evaluate((id) => {
    const strip = document.querySelector<HTMLElement>(`[data-tab-group-strip-id="${id}"]`)
    if (!strip) {
      return { width: 0, x: 0 }
    }
    const rect = strip.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    let best = { width: 0, x: 0 }
    let runStart = 0
    let run = 0
    for (let x = Math.ceil(rect.left); x < rect.right; x++) {
      const hit = document.elementFromPoint(x, y)
      const tab = hit?.closest('[data-tab-id]')
      const draggable = tab && strip.contains(tab) && !hit?.closest('button, input')
      if (draggable) {
        runStart = run === 0 ? x : runStart
        run++
        if (run > best.width) {
          best = { width: run, x: runStart + run / 2 }
        }
      } else {
        run = 0
      }
    }
    return best
  }, groupId)
}

type FocusedControl = { label: string; fullyVisible: boolean } | 'in-tab' | null

/** The strip control holding focus (null outside the strip, 'in-tab' for a tab's own controls) and whether all of it is visible. */
async function focusedStripControl(page: Page, groupId: string): Promise<FocusedControl> {
  return page.evaluate((id) => {
    const el = document.activeElement
    const stripEl = document.querySelector(`[data-tab-group-strip-id="${id}"]`)
    if (!(el instanceof HTMLElement) || !stripEl?.contains(el)) {
      return null
    }
    if (el.closest('[data-tab-id]')) {
      return 'in-tab'
    }
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    const shows = (x: number): boolean => {
      const hit = document.elementFromPoint(x, y)
      return Boolean(hit && (hit === el || el.contains(hit)))
    }
    return {
      label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
      fullyVisible: r.width > 0 && shows(r.left + 1) && shows(r.right - 1)
    }
  }, groupId)
}

/** Tab through a strip from its first tab; report each strip control (not a tab's own close button) that took focus. */
async function tabThroughStrip(
  page: Page,
  groupId: string
): Promise<{ label: string; fullyVisible: boolean }[]> {
  const tab = page.locator(`[data-tab-group-strip-id="${groupId}"] [data-tab-id]`).first()
  // Why: focusing a group can hand focus to its terminal a beat later, so retry until Tab from the tab lands in the strip.
  await expect
    .poll(async () => {
      await tab.focus()
      await page.keyboard.press('Tab')
      return focusedStripControl(page, groupId)
    })
    .not.toBeNull()
  let focused = await focusedStripControl(page, groupId)
  const visited: { label: string; fullyVisible: boolean }[] = []
  for (let i = 0; i < 8 && focused; i++) {
    if (focused !== 'in-tab') {
      visited.push(focused)
    }
    await page.keyboard.press('Tab')
    focused = await focusedStripControl(page, groupId)
  }
  return visited
}

test('a narrow tab group keeps a grabbable tab and can be dragged into another group', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const layout = await buildThreeColumns(orcaPage, worktreeId)
  const rightStrip = orcaPage.locator(`[data-tab-group-strip-id="${layout.rightGroupId}"]`)
  await expect.poll(async () => (await rightStrip.boundingBox())?.width ?? 0).toBeGreaterThan(200)

  // At normal width the strip's controls are all reachable by Tab and fully visible.
  const wideFocus = await tabThroughStrip(orcaPage, layout.rightGroupId)
  expect(wideFocus.map((control) => control.label)).toEqual(
    expect.arrayContaining(['New tab', 'Pane Actions'])
  )
  expect(wideFocus.filter((control) => !control.fullyVisible)).toEqual([])

  await narrowRightColumns(orcaPage, worktreeId)
  await expect.poll(async () => (await rightStrip.boundingBox())?.width ?? 0).toBeLessThan(120)

  await expect
    .poll(async () => (await draggableTabRun(orcaPage, layout.rightGroupId)).width)
    .toBeGreaterThanOrEqual(16)

  // Keyboard users only reach controls they can see: anything that would clip is hidden instead.
  const narrowFocus = await tabThroughStrip(orcaPage, layout.rightGroupId)
  expect(narrowFocus.map((control) => control.label)).toContain('New tab')
  expect(narrowFocus.filter((control) => !control.fullyVisible)).toEqual([])

  const run = await draggableTabRun(orcaPage, layout.rightGroupId)
  const tabBox = await rightStrip.locator('[data-tab-id]').first().boundingBox()
  const leftBody = await orcaPage
    .locator(`[data-tab-group-body-id="${layout.leftGroupId}"]`)
    .boundingBox()
  if (!tabBox || !leftBody) {
    throw new Error('Drag geometry missing')
  }
  const startX = run.x
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

test('a strip too narrow for quick commands offers them in the pane actions menu', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const layout = await buildThreeColumns(orcaPage, worktreeId)
  const rightStrip = orcaPage.locator(`[data-tab-group-strip-id="${layout.rightGroupId}"]`)
  const paneActions = rightStrip.getByRole('button', { name: 'Pane Actions' })
  const quickCommandsItem = orcaPage.getByRole('menuitem', { name: 'Quick Commands' })

  // Normal width shows the quick-command button, so the menu does not repeat it.
  await expect(rightStrip.getByRole('button', { name: 'Add quick command' })).toBeVisible()
  await paneActions.click()
  await expect(orcaPage.getByRole('menuitem', { name: 'Close split pane' })).toBeVisible()
  await expect(quickCommandsItem).toHaveCount(0)
  await orcaPage.keyboard.press('Escape')

  // Root 80/20, then 25/75 inside it: about 134px, too narrow for quick commands but not for the menu.
  await orcaPage.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setTabGroupSplitRatio(id, '', 0.8)
    state?.setTabGroupSplitRatio(id, 'second', 0.25)
  }, worktreeId)
  await expect(rightStrip.getByRole('button', { name: 'Add quick command' })).toBeHidden()
  await paneActions.click()
  await expect(quickCommandsItem).toBeVisible()
})

test('with the right sidebar closed, no focused strip control is clipped at any width', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // The top-right strip now also holds the window-drag gap and the reserved toggle/window-controls space.
  const layout = await buildThreeColumns(orcaPage, worktreeId, false)
  for (const secondRatio of [0.15, 0.3, 0.45, 0.6]) {
    await orcaPage.evaluate(
      ({ id, ratio }) => {
        const state = window.__store?.getState()
        state?.setTabGroupSplitRatio(id, '', 0.8)
        state?.setTabGroupSplitRatio(id, 'second', ratio)
      },
      { id: worktreeId, ratio: secondRatio }
    )
    const focus = await tabThroughStrip(orcaPage, layout.rightGroupId)
    expect(
      focus.filter((control) => !control.fullyVisible),
      `ratio ${secondRatio}`
    ).toEqual([])
  }
})
