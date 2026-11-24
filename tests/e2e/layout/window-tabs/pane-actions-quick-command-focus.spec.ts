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
  await page.setViewportSize({ width: 1280, height: 800 })
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

/** Split panes size by ratio; an unsplit owner pane sizes by the right sidebar beside it. */
async function setOwnerPaneWidth(page: Page, groupId: string, split: boolean, px: number) {
  await page.evaluate(
    ({ gid, split, px }) => {
      const state = window.__store!.getState()
      const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
      if (split) {
        const row = strip?.closest('.workspace-sidebar-seam')?.getBoundingClientRect().width ?? 0
        state.setTabGroupSplitRatio(state.activeWorktreeId!, '', px / row)
      } else {
        const current = strip?.getBoundingClientRect().width ?? px
        state.setRightSidebarWidth(Math.max(200, state.rightSidebarWidth + current - px))
      }
    },
    { gid: groupId, split, px }
  )
  // Let the resize observers and the fold commit settle over a few frames.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 4; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  })
}

/** Narrow until the titlebar folds into the strip: ⋯ shows and quick commands move into it. */
async function foldOwnerPane(page: Page, groupId: string, split: boolean): Promise<void> {
  for (let px = 440; px >= 200; px -= 20) {
    await setOwnerPaneWidth(page, groupId, split, px)
    const state = await ownerStripState(page, groupId)
    if (state.paneActions && !state.inlineQuickCommands) {
      return
    }
  }
  throw new Error(
    `Owner pane never folded: ${JSON.stringify(await ownerStripState(page, groupId))}`
  )
}

/** Widen until the strip unfolds: quick commands return inline, and an unsplit pane drops ⋯. */
async function unfoldOwnerPane(page: Page, groupId: string, split: boolean): Promise<void> {
  for (let px = 520; px <= 1000; px += 40) {
    await setOwnerPaneWidth(page, groupId, split, px)
    const state = await ownerStripState(page, groupId)
    if (state.inlineQuickCommands && (split || !state.paneActions)) {
      return
    }
  }
  throw new Error(
    `Owner pane never unfolded: ${JSON.stringify(await ownerStripState(page, groupId))}`
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

for (const split of [false, true]) {
  const pane = split ? 'split' : 'unsplit'
  for (const how of ['Save', 'Cancel', 'Escape'] as const) {
    test(`Add Quick Command from a folded ${pane} owner pane returns focus to ⋯ after ${how}`, async ({
      orcaPage
    }) => {
      const groupId = await seedOwnerPane(orcaPage, split)
      await foldOwnerPane(orcaPage, groupId, split)
      await openAddFromPaneActions(orcaPage, groupId)
      await closeAddDialog(orcaPage, how)
      await expectLandingAndTabOrder(orcaPage, groupId, 'owner-pane-actions')
    })

    test(`Add Quick Command in a ${pane} pane that unfolds under the draft returns focus after ${how}`, async ({
      orcaPage
    }) => {
      const groupId = await seedOwnerPane(orcaPage, split)
      await foldOwnerPane(orcaPage, groupId, split)
      await openAddFromPaneActions(orcaPage, groupId)
      await unfoldOwnerPane(orcaPage, groupId, split)
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
