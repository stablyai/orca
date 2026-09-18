// The real launch picker follows the pointer, selects a workspace, and launches a shell.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import es from '../../src/renderer/src/i18n/locales/es.json'

const EMPTY_SLOT = '[data-testid="session-grid-empty-slot"]'
const MENU = '[data-slot="popover-content"]'

/** Open the menu at an offset inside the first vacant cell; returns the click point and the menu's corner. */
async function openMenuAt(
  page: Page,
  offset: { x: number; y: number }
): Promise<{ clickX: number; clickY: number; menuX: number; menuY: number }> {
  const slot = page.locator(EMPTY_SLOT).first()
  const slotBox = await slot.boundingBox()
  if (!slotBox) {
    throw new Error('Empty slot has no bounds')
  }
  await slot.click({ position: offset })
  const menu = page.locator(MENU)
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  if (!menuBox) {
    throw new Error('Launch picker has no bounds')
  }
  return {
    clickX: slotBox.x + offset.x,
    clickY: slotBox.y + offset.y,
    menuX: menuBox.x,
    menuY: menuBox.y
  }
}

test('the grid launch picker follows the cursor and launches in the selected workspace', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async (worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
      state.createTab(worktreeId, undefined, undefined, {
        activate: false,
        id: 'session-grid-launch-menu-e2e'
      })
    }
    // I18nProvider applies this to i18next; the whole test then runs translated.
    await state.updateSettings({ uiLanguage: 'es' })
    store.setState({
      sessionsGridPreset: '3x3',
      sessionsGridScrollMode: 'row',
      sessionsGridShowEmpty: true,
      sessionsGridFilter: 'all'
    })
    state.openSessionsPage()
  }, worktreeId)
  await expect(orcaPage.locator(EMPTY_SLOT).first()).toBeVisible()

  const first = await openMenuAt(orcaPage, { x: 30, y: 20 })
  expect(Math.abs(first.menuX - first.clickX)).toBeLessThanOrEqual(12)
  expect(Math.abs(first.menuY - first.clickY)).toBeLessThanOrEqual(12)
  const menu = orcaPage.locator(MENU)
  await expect(menu.locator('[data-slot="command-input"]')).toHaveAttribute(
    'placeholder',
    es.auto.components.session.grid.SessionGridLaunchPicker.search
  )
  const listMaxHeight = await menu
    .locator('[data-slot="command-list"]')
    .evaluate((node) => getComputedStyle(node).maxHeight)
  expect(listMaxHeight).not.toBe('none')
  await orcaPage.getByTestId('session-grid-launch-workspace').first().click()
  const targets = orcaPage.getByTestId('session-grid-launch-targets')
  await expect(targets).toBeVisible()
  await expect(targets.getByTestId('session-grid-launch-shell')).toBeVisible()
  await expect(targets.locator('[data-slot="command-item"]').last()).toHaveText(
    es.auto.components.session.grid.SessionGridLaunchPicker.agentSettings
  )
  await orcaPage.keyboard.press('ArrowLeft')
  await expect(menu.locator('[data-slot="command-input"]')).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const second = await openMenuAt(orcaPage, { x: 100, y: 60 })
  expect(second.menuX - first.menuX).toBeGreaterThan(50)
  expect(second.menuY - first.menuY).toBeGreaterThan(20)
  await orcaPage.getByTestId('session-grid-launch-workspace').first().click()
  const before = await orcaPage.evaluate(
    (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
    worktreeId
  )
  await orcaPage.getByTestId('session-grid-launch-shell').click()
  await expect(menu).toBeHidden()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
        worktreeId
      )
    )
    .toBe(before + 1)
  await expect(orcaPage.getByTestId('session-grid-card')).toHaveCount(before + 1)
})
