import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

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

/** Widest run of strip pixels where a press starts a tab drag: a tab, but not its close button or other inner controls. */

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
  // A strip whose controls all hid beside an icon-only tab has nothing to land on: report none.
  const hasStripControl = await page.evaluate(
    (id) =>
      [...document.querySelectorAll<HTMLElement>(`[data-tab-group-strip-id="${id}"] button`)].some(
        (button) => !button.closest('[data-tab-id]') && button.offsetParent !== null
      ),
    groupId
  )
  if (!hasStripControl) {
    return []
  }
  // Why: focusing a group can hand focus to its terminal a beat later, so retry Tab from the tab.
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

test('a narrow strip anchors the shortcut-opened quick-command menu and Escape returns focus to the terminal', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const layout = await buildThreeColumns(orcaPage, worktreeId)
  await orcaPage.evaluate(async (id) => {
    const state = window.__store?.getState()
    state?.setTabGroupSplitRatio(id, '', 0.8)
    state?.setTabGroupSplitRatio(id, 'second', 0.25)
    await state?.upsertTerminalQuickCommand('local', {
      id: 'e2e-narrow-strip-quick-command',
      label: 'Narrow strip echo',
      scope: { type: 'global' },
      command: 'echo narrow',
      appendEnter: true
    })
  }, worktreeId)
  const rightStrip = orcaPage.locator(`[data-tab-group-strip-id="${layout.rightGroupId}"]`)
  const runButton = rightStrip.getByRole('button', {
    name: 'Run quick command: Narrow strip echo',
    includeHidden: true
  })
  // Wait for the saved command to mount the menu trigger, which the narrow strip keeps hidden.
  await expect(runButton).toHaveCount(1)
  await expect(runButton).toBeHidden()

  await rightStrip.locator('[data-tab-id]').first().click()
  const focusedTextarea = orcaPage.locator('.xterm-helper-textarea:focus')
  await expect(focusedTextarea).toHaveCount(1)
  const terminalTabId = await focusedTextarea.evaluate(
    (el) => el.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ?? null
  )
  expect(terminalTabId).not.toBeNull()

  await orcaPage.evaluate(() => window.dispatchEvent(new Event('orca:toggleQuickCommandsMenu')))
  const menu = orcaPage.getByRole('menu')
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  const stripBox = await rightStrip.boundingBox()
  if (!menuBox || !stripBox) {
    throw new Error('Quick-command menu or strip has no layout box')
  }
  // A rect-less trigger put the menu at the window origin; it should hang from the pane's top-right edge.
  expect(menuBox.x).toBeGreaterThan(0)
  expect(Math.abs(menuBox.x + menuBox.width - (stripBox.x + stripBox.width))).toBeLessThan(8)

  await orcaPage.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(
    orcaPage.locator(`[data-terminal-tab-id="${terminalTabId}"] .xterm-helper-textarea`)
  ).toBeFocused()
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
