import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { waitForActiveWorktree } from '../../desktop/renderer-probes/store'

test('in a short window, the last Help row in the app rail More menu can be reached', async ({
  orcaPage
}) => {
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    await state.updateSettings({ experimentalAppRail: true })
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
  })
  // About the smallest window at maximum zoom: Help and Settings fold into More, and Help's rows outgrow the window.
  await orcaPage.setViewportSize({ width: 1200, height: 161 })

  await orcaPage.locator('[data-app-rail-item=more]').click()
  const help = orcaPage.getByRole('menuitem', { name: 'Help', exact: true })
  await help.hover()
  await help.press('ArrowRight')
  const helpRows = orcaPage.locator('[data-slot=dropdown-menu-sub-content]').getByRole('menuitem')
  await expect(helpRows.first()).toBeVisible()

  await orcaPage.keyboard.press('End')
  const lastRow = helpRows.last()
  await expect(lastRow).toBeFocused()
  await expect(lastRow).toBeInViewport()
})
