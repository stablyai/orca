import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { showActivePaneAsNativeChat } from './helpers/native-chat-view'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

test('Cmd+J reselecting the active terminal chat returns editing keys to its composer', async ({
  orcaPage,
  electronApp
}) => {
  await orcaPage.setViewportSize({ width: 1200, height: 800 })
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const tabId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setTabCustomTitle(state.activeTabId!, 'Palette chat terminal')
    return state.activeTabId!
  })
  await showActivePaneAsNativeChat(orcaPage, 'claude', 'Example agent')
  const terminalTab = orcaPage.locator(`[data-terminal-tab-id="${tabId}"]`)
  const composer = terminalTab.getByRole('textbox', {
    name: 'Ask anything, @ to mention files, / for commands',
    exact: true
  })
  await composer.click()
  await orcaPage.keyboard.type('draft')
  await expect(composer).toHaveText('draft')

  // Native menu accelerators need desktop focus; open the same palette in the hidden renderer.
  await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
  await palette.getByRole('combobox').fill('Palette chat terminal')
  await expect(palette.locator('[cmdk-item][data-selected="true"]')).toContainText(
    'Palette chat terminal'
  )
  await palette.getByRole('combobox').press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(composer).toBeFocused()
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.keyboard.type('X')
  await expect(composer).toHaveText('drafXt')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
