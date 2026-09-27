import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'

async function pressSideButton(
  page: Page,
  target: Locator,
  button: 'back' | 'forward',
  modifiers = 0
): Promise<void> {
  const bounds = await target.boundingBox()
  if (!bounds) {
    throw new Error('Mouse shortcut target is not rendered')
  }
  const session = await page.context().newCDPSession(page)
  try {
    const event = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
      button,
      modifiers,
      clickCount: 1
    }
    await session.send('Input.dispatchMouseEvent', {
      ...event,
      type: 'mousePressed',
      buttons: button === 'back' ? 8 : 16
    })
    await session.send('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased', buttons: 0 })
  } finally {
    await session.detach()
  }
}

test('records mouse buttons with modifiers and switches rendered terminal tabs', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const tabs = await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId || !state.activeTabId) {
      throw new Error('No active terminal')
    }
    const first = state.activeTabId
    const second = state.createTab(state.activeWorktreeId).id
    await state.updateSettings({ uiLanguage: 'en' })
    state.openSettingsPage()
    return { first, second }
  })
  await orcaPage.getByPlaceholder('Search settings').fill('shortcuts')
  const search = orcaPage.getByPlaceholder('Search command or keys')
  await search.fill('Previous tab (same type)')
  await orcaPage
    .getByRole('button', { name: 'Change shortcut for Previous tab (same type)', exact: true })
    .click()
  await pressSideButton(orcaPage, orcaPage.locator('[data-shortcut-recorder-active]'), 'back')
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('recorded-mouse-back.png')
  })
  await expect(orcaPage.locator('[data-shortcut-recorder-active]')).toHaveCount(0)
  await expect(orcaPage.locator('[data-shortcut-recorder]')).toContainText('Mouse Back')

  await search.fill('Next tab (same type)')
  await orcaPage
    .getByRole('button', { name: 'Change shortcut for Next tab (same type)', exact: true })
    .click()
  // CDP modifier bit 8 is Shift on every supported platform.
  await pressSideButton(orcaPage, orcaPage.locator('[data-shortcut-recorder-active]'), 'forward', 8)
  await expect(orcaPage.locator('[data-shortcut-recorder-active]')).toHaveCount(0)
  await expect(orcaPage.locator('[data-shortcut-recorder]')).toContainText('Mouse Forward')
  await expect
    .poll(() => orcaPage.evaluate(async () => (await window.api.keybindings.reload()).overrides))
    .toMatchObject({
      'tab.previousSameType': ['MouseBack'],
      'tab.nextSameType': ['Shift+MouseForward']
    })
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('recorded-shift-mouse-forward.png')
  })
  await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
  const firstTab = orcaPage.locator(`[data-tab-id="${tabs.first}"]`)
  const secondTab = orcaPage.locator(`[data-tab-id="${tabs.second}"]`)
  await secondTab.click()
  await expect(secondTab).toHaveAttribute('data-active', 'true')
  const terminal = orcaPage.locator(`[data-terminal-tab-id="${tabs.second}"] .xterm-screen`)
  await pressSideButton(orcaPage, terminal, 'back')
  await expect(firstTab).toHaveAttribute('data-active', 'true')
  await expect(secondTab).toHaveAttribute('data-active', 'false')
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('mouse-back-terminal.png')
  })
  const firstTerminal = orcaPage.locator(`[data-terminal-tab-id="${tabs.first}"] .xterm-screen`)
  await pressSideButton(orcaPage, firstTerminal, 'forward')
  await expect(firstTab).toHaveAttribute('data-active', 'true')
  await pressSideButton(orcaPage, firstTerminal, 'forward', 8)
  await expect(secondTab).toHaveAttribute('data-active', 'true')
  await expect(firstTab).toHaveAttribute('data-active', 'false')
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('shift-mouse-forward-terminal.png')
  })
})

test('opens Settings with a recorded mouse shortcut for a native menu action', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    await state.updateSettings({ uiLanguage: 'en' })
    state.openSettingsPage()
  })
  await orcaPage.getByPlaceholder('Search settings').fill('shortcuts')
  await orcaPage.getByPlaceholder('Search command or keys').fill('Open Settings')
  await orcaPage
    .getByRole('button', { name: 'Add shortcut for Open Settings', exact: true })
    .click()
  await pressSideButton(orcaPage, orcaPage.locator('[data-shortcut-recorder-active]'), 'back')
  await expect(orcaPage.locator('[data-shortcut-recorder-active]')).toHaveCount(0)
  await expect(orcaPage.locator('[data-shortcut-recorder]')).toContainText('Mouse Back')
  await orcaPage.getByRole('button', { name: 'Back to app', exact: true }).click()
  await expect(orcaPage.getByPlaceholder('Search settings')).not.toBeVisible()
  await pressSideButton(
    orcaPage,
    orcaPage.locator('.xterm-screen').filter({ visible: true }),
    'back'
  )
  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('mouse-back-opens-settings.png')
  })
})
