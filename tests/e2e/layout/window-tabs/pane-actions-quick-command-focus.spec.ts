import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

/** Six terminals in the left (owner) pane with the sidebar collapsed; split adds a right pane. */
async function seedOwnerPane(page: Page, split: boolean): Promise<string> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  return page.evaluate(
    async ({ id, split }) => {
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
      if (split) {
        const right = state.createEmptySplitGroup(id, groupId, 'right')
        if (!right) {
          throw new Error('Right split was not created')
        }
        state.createTab(id, right, undefined, { activate: true })
        state.focusGroup(id, groupId)
      }
      return groupId
    },
    { id: worktreeId, split }
  )
}

const foldLevel = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Number(
      document
        .querySelector('[data-titlebar-fold-level]')
        ?.getAttribute('data-titlebar-fold-level') ?? -1
    )
  )

/** The window sets the owner pane's width: shrink until it folds, or grow until it unfolds. */
async function resizeUntilFold(page: Page, wanted: (level: number) => boolean, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 760 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    if (wanted(await foldLevel(page))) {
      return
    }
  }
  throw new Error('The owner pane never reached the wanted fold level')
}
const narrowWidths = Array.from({ length: 35 }, (_, i) => 1100 - i * 20)
const wideWidths = Array.from({ length: 25 }, (_, i) => 700 + i * 40)

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

for (const split of [false, true]) {
  const pane = split ? 'split' : 'unsplit'
  for (const how of ['Save', 'Cancel', 'Escape'] as const) {
    test(`Add Quick Command from a folded ${pane} owner pane returns focus to ⋯ after ${how}`, async ({
      orcaPage
    }) => {
      const groupId = await seedOwnerPane(orcaPage, split)
      await resizeUntilFold(orcaPage, (level) => level >= 1, narrowWidths)
      await openAddFromPaneActions(orcaPage, groupId)
      await closeAddDialog(orcaPage, how)
      await expectLandingAndTabOrder(orcaPage, groupId, 'owner-pane-actions')
    })

    test(`Add Quick Command in a ${pane} pane that unfolds under the draft returns focus after ${how}`, async ({
      orcaPage
    }) => {
      const groupId = await seedOwnerPane(orcaPage, split)
      await resizeUntilFold(orcaPage, (level) => level >= 1, narrowWidths)
      await openAddFromPaneActions(orcaPage, groupId)
      await resizeUntilFold(orcaPage, (level) => level === 0, wideWidths)
      await expect(addDialog(orcaPage).getByPlaceholder('Start dev server')).toHaveValue(
        'Lint the repo'
      )
      await closeAddDialog(orcaPage, how)
      // An unsplit pane drops ⋯ at fold 0, so its active tab takes focus instead.
      await expectLandingAndTabOrder(
        orcaPage,
        groupId,
        split ? 'owner-pane-actions' : 'owner-active-tab'
      )
    })
  }
}
