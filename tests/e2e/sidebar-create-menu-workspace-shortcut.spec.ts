import { test, expect } from './helpers/orca-app'
import { worktreeRow } from './worktree-row-locators'

test('a workspace shortcut releases focus restored to a sidebar create trigger', async ({
  orcaPage,
  electronApp
}) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const original = state.activeWorktreeId!
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((row) => row.id !== original)!.id
    const tab =
      state.tabsByWorktree[other]?.[0] ??
      state.createTab(other, undefined, undefined, { activate: false })
    state.setActiveWorktree(other)
    return { original, other, tab: tab.id }
  })
  const terminal = orcaPage
    .locator(`[data-terminal-tab-id="${setup.tab}"] .xterm-helper-textarea`)
    .first()
  await expect(terminal).toBeAttached()
  await orcaPage.evaluate((id) => window.__store!.getState().setActiveWorktree(id), setup.original)
  const trigger = worktreeRow(orcaPage, setup.original).getByRole('button', {
    name: 'New tab',
    exact: true
  })
  await trigger.click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect.poll(() => trigger.evaluate((node) => node === document.activeElement)).toBe(true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ui:jumpToWorktreeIndex', 1)
  })
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
    .toBe(setup.other)
  await expect(trigger).toBeAttached()
  await expect.poll(() => terminal.evaluate((node) => node === document.activeElement)).toBe(true)
})
