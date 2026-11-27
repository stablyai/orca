import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

/** Six terminals in the left (owner) pane with the sidebar collapsed, beside a right split pane. */
async function seedOwnerPane(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  return page.evaluate(
    async ({ id }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      await state.updateSettings({
        terminalQuickCommands: [
          {
            id: 'e2e-command',
            label: 'Check formatting',
            command: 'npm run format:check',
            appendEnter: false,
            scope: { type: 'global' }
          }
        ]
      })
      state.setSidebarOpen(false)
      state.setRightSidebarOpen(true)
      const groupId = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id]?.[0]?.id
      if (!groupId) {
        throw new Error('No root tab group')
      }
      const existing = (state.unifiedTabsByWorktree[id] ?? []).filter(
        (tab) => tab.groupId === groupId
      ).length
      for (let i = existing; i < 6; i++) {
        state.createTab(id, groupId, undefined, { activate: i === 0 })
      }
      const right = state.createEmptySplitGroup(id, groupId, 'right')
      if (!right) {
        throw new Error('Right split was not created')
      }
      state.createTab(id, right, undefined, { activate: true })
      state.focusGroup(id, groupId)
      return groupId
    },
    { id: worktreeId }
  )
}

/** Owner-strip state that decides what ⋯ offers; platforms differ in header width, so read it rather than assume it. */
function ownerStripState(page: Page, groupId: string) {
  return page.evaluate((gid) => {
    const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
    const shown = (element: Element | null | undefined): boolean =>
      element instanceof HTMLElement && element.checkVisibility({ visibilityProperty: true })
    return {
      paneActions: shown(strip?.querySelector('[data-pane-actions-menu-trigger]')),
      inlineQuickCommands: shown(strip?.querySelector('button[aria-label="More quick commands"]'))
    }
  }, groupId)
}

/** Split panes size by ratio. */
async function setOwnerPaneWidth(page: Page, groupId: string, px: number) {
  await page.evaluate(
    ({ gid, px }) => {
      const state = window.__store!.getState()
      const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
      const row = strip?.closest('.workspace-sidebar-seam')?.getBoundingClientRect().width ?? 0
      state.setTabGroupSplitRatio(state.activeWorktreeId!, '', px / row)
    },
    { gid: groupId, px }
  )
  // Let the strip's container queries settle over a few frames.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  })
}

/** Narrow until the strip hides its inline quick commands and ⋯ offers them instead. */
async function narrowOwnerPane(page: Page, groupId: string): Promise<void> {
  for (let px = 440; px >= 150; px -= 10) {
    await setOwnerPaneWidth(page, groupId, px)
    const state = await ownerStripState(page, groupId)
    if (state.paneActions && !state.inlineQuickCommands) {
      return
    }
  }
  throw new Error(
    `Owner pane never narrowed: ${JSON.stringify(await ownerStripState(page, groupId))}`
  )
}

/** Widen until quick commands return inline. */
async function widenOwnerPane(page: Page, groupId: string): Promise<void> {
  for (let px = 520; px <= 1000; px += 40) {
    await setOwnerPaneWidth(page, groupId, px)
    const state = await ownerStripState(page, groupId)
    if (state.inlineQuickCommands) {
      return
    }
  }
  throw new Error(
    `Owner pane never widened: ${JSON.stringify(await ownerStripState(page, groupId))}`
  )
}

/** Where focus is, relative to the owner strip, without exposing terminal text. */
function focusTarget(page: Page, groupId: string): Promise<string> {
  return page.evaluate((gid) => {
    const active = document.activeElement
    if (!active || active === document.body) {
      return 'body'
    }
    const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
    if (active.hasAttribute('data-pane-actions-menu-trigger')) {
      return strip?.contains(active) ? 'owner-pane-actions' : 'other-pane-actions'
    }
    const slot = active.closest('[data-tab-strip-slot]')
    if (slot && strip?.contains(slot)) {
      return active.querySelector('[data-active="true"]') || active.matches('[data-active="true"]')
        ? 'owner-active-tab'
        : 'owner-tab'
    }
    if (strip?.contains(active)) {
      return 'owner-strip-control'
    }
    return active.closest('[role="dialog"]') ? 'dialog' : 'elsewhere'
  }, groupId)
}

const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add Quick Command' })

async function openAddFromPaneActions(page: Page, groupId: string): Promise<void> {
  await page
    .locator(`[data-tab-group-strip-id="${groupId}"] [data-pane-actions-menu-trigger]`)
    .click()
  await page.getByRole('menuitem', { name: 'Quick Commands' }).click()
  await page.getByRole('menuitem', { name: /^Add Quick Command/ }).click()
  await expect(addDialog(page)).toBeVisible()
  await addDialog(page).getByPlaceholder('Start dev server').click()
  await page.keyboard.type('Lint the repo')
  await addDialog(page).locator('textarea').first().click()
  await page.keyboard.type('npm run lint')
}

async function closeAddDialog(page: Page, how: 'Save' | 'Cancel' | 'Escape'): Promise<void> {
  await (how === 'Escape'
    ? page.keyboard.press('Escape')
    : addDialog(page)
        .getByRole('button', { name: how === 'Save' ? /^Save/ : 'Cancel' })
        .click())
  await expect(addDialog(page)).toHaveCount(0)
}

/** Lands in the owner pane, and Shift+Tab then Tab moves through the strip and back to it. */
async function expectLandingAndTabOrder(page: Page, groupId: string, landing: string) {
  await expect.poll(() => focusTarget(page, groupId)).toBe(landing)
  await page.keyboard.press('Shift+Tab')
  const previous = await focusTarget(page, groupId)
  expect(previous).not.toBe('body')
  expect(previous).not.toBe(landing)
  await page.keyboard.press('Tab')
  await expect.poll(() => focusTarget(page, groupId)).toBe(landing)
  await page.keyboard.press('Tab')
  expect(await focusTarget(page, groupId)).not.toBe('body')
}

for (const how of ['Save', 'Cancel', 'Escape'] as const) {
  test(`Add Quick Command from a narrow split pane's ⋯ returns focus to ⋯ after ${how}`, async ({
    orcaPage
  }) => {
    const groupId = await seedOwnerPane(orcaPage)
    await narrowOwnerPane(orcaPage, groupId)
    await openAddFromPaneActions(orcaPage, groupId)
    await closeAddDialog(orcaPage, how)
    await expectLandingAndTabOrder(orcaPage, groupId, 'owner-pane-actions')
  })

  test(`Add Quick Command in a split pane that widens under the draft returns focus after ${how}`, async ({
    orcaPage
  }) => {
    const groupId = await seedOwnerPane(orcaPage)
    await narrowOwnerPane(orcaPage, groupId)
    await openAddFromPaneActions(orcaPage, groupId)
    await widenOwnerPane(orcaPage, groupId)
    await expect(addDialog(orcaPage).getByPlaceholder('Start dev server')).toHaveValue(
      'Lint the repo'
    )
    await closeAddDialog(orcaPage, how)
    await expectLandingAndTabOrder(orcaPage, groupId, 'owner-pane-actions')
  })
}
