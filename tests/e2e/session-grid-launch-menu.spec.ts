// The grid's launch menu in the real app: it opens where the pointer was rather than against the
// card's box, it offers the canonical agent menu instead of a hard-coded Claude entry, and a
// workspace submenu is height-capped so a long one can be scrolled instead of running off screen.
//
// The app is driven in Spanish on purpose. Every locator here is structural — a test id or a
// data-slot — and the one text expectation is read out of the shipped catalogs rather than typed,
// so nothing in this file can quietly start depending on English copy.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const EMPTY_SLOT = '[data-testid="session-grid-empty-slot"]'
const MENU = '[data-slot="dropdown-menu-content"]'
const MENU_ITEM = '[data-slot="dropdown-menu-item"]'
const SUB_TRIGGER = '[data-slot="dropdown-menu-sub-trigger"]'
const SUB_CONTENT = '[data-slot="dropdown-menu-sub-content"]'
// The launcher's own settings row. Its Spanish differs from its English, which is what proves the
// forced locale actually took — and that the canonical launcher, not the old pair, is mounted.
const AGENT_SETTINGS_KEY = 'auto.components.tab.bar.QuickLaunchButton.348a04c1ad'

function catalogEntry(locale: string, key: string): string | undefined {
  const catalog = JSON.parse(
    readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'i18n',
        'locales',
        `${locale}.json`
      ),
      'utf8'
    )
  ) as Record<string, unknown>
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }, catalog) as string | undefined
}

/** Open the menu at an offset inside the first vacant cell; returns the click point and the menu's corner. */
async function openMenuAt(
  page: Page,
  offset: { x: number; y: number }
): Promise<{ clickX: number; clickY: number; menuX: number; menuY: number }> {
  const slot = page.locator(EMPTY_SLOT).first()
  const slotBox = (await slot.boundingBox())!
  await slot.click({ position: offset })
  const menu = page.locator(MENU)
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  return {
    clickX: slotBox.x + offset.x,
    clickY: slotBox.y + offset.y,
    menuX: menuBox.x,
    menuY: menuBox.y
  }
}

test('the grid launch menu follows the cursor and offers detected agents', async ({ orcaPage }) => {
  test.setTimeout(180_000)
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

  // The menu is anchored to the click, so moving the click moves the menu by the same
  // delta. Anchored to the card's box — what this replaced — both openings would coincide.
  const first = await openMenuAt(orcaPage, { x: 30, y: 20 })
  expect(Math.abs(first.menuX - first.clickX)).toBeLessThanOrEqual(12)
  expect(Math.abs(first.menuY - first.clickY)).toBeLessThanOrEqual(12)

  // The canonical launcher, not the old hand-written pair: a shell, whatever this host
  // detected (each agent row carries a per-agent title), then the settings row. The old
  // menu had exactly two items here and no settings row at all.
  const menu = orcaPage.locator(MENU)
  const items = menu.locator(MENU_ITEM)
  expect(await items.count()).toBeGreaterThanOrEqual(3)
  const agentSettingsLabel =
    catalogEntry('es', AGENT_SETTINGS_KEY) ?? catalogEntry('en', AGENT_SETTINGS_KEY)!
  await expect(items.last()).toHaveText(agentSettingsLabel)
  const hasDetectedAgents = await orcaPage.evaluate(
    () => (window.__store!.getState().detectedAgentIds ?? []).length > 0
  )
  if (hasDetectedAgents) {
    expect(await menu.locator(`${MENU_ITEM}[title]`).count()).toBeGreaterThan(0)
  }

  // Workspace → agent: the picker's submenus are workspaces, each opening onto that same
  // launcher — the inverted shape, where a submenu used to hold workspaces for one agent.
  // And each is height-capped, so a long one scrolls instead of running off screen.
  const subTrigger = orcaPage.locator(SUB_TRIGGER).first()
  await subTrigger.hover()
  const subContent = orcaPage.locator(SUB_CONTENT)
  await expect(subContent).toBeVisible()
  await expect(subContent.locator(MENU_ITEM).last()).toHaveText(agentSettingsLabel)
  const subMaxHeight = await subContent.evaluate((node) => getComputedStyle(node).maxHeight)
  expect(subMaxHeight).not.toBe('none')

  await orcaPage.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const second = await openMenuAt(orcaPage, { x: 100, y: 60 })
  expect(second.menuX - first.menuX).toBeGreaterThan(50)
  expect(second.menuY - first.menuY).toBeGreaterThan(20)
})
