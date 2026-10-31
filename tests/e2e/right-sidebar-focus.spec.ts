import { test, expect } from './helpers/orca-app'
import { pressShortcut } from './helpers/shortcuts'
import { ensureTerminalVisible } from './helpers/store'
import {
  getTerminalContent,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import {
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

test.beforeEach(async ({ orcaPage }) => {
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForPaneCount(orcaPage, 1)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(false)
  })
})

for (const position of ['top', 'side'] as const) {
  test(`right sidebar mouse roundtrip preserves split-pane input with ${position} activity bar`, async ({
    orcaPage
  }) => {
    await orcaPage.evaluate((position) => {
      window.__store!.getState().setActivityBarPosition(position)
    }, position)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const input = orcaPage.getByRole('textbox', { name: 'Terminal input', exact: true }).nth(1)
    const toggle = orcaPage.getByRole('button', { name: 'Toggle right sidebar', exact: true })
    await input.click()
    await expect(input).toBeFocused()
    await toggle.click()
    await expect(orcaPage.getByRole('textbox', { name: 'Find files', exact: true })).toBeVisible()
    await toggle.click()
    await expect(input).toBeFocused()
    const marker = `sidebar-input-${position}`
    await orcaPage.keyboard.type(marker)
    await expect.poll(() => getTerminalContent(orcaPage)).toContain(marker)
  })
}

test('closing sidebar search returns to the most recently used pane, not the opener', async ({
  orcaPage
}) => {
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  const inputs = orcaPage.getByRole('textbox', { name: 'Terminal input', exact: true })
  const toggle = orcaPage.getByRole('button', { name: 'Toggle right sidebar', exact: true })
  const search = orcaPage.getByRole('textbox', { name: 'Find files', exact: true })
  await inputs.first().click()
  await toggle.click()
  await search.fill('README')
  await inputs.nth(1).click()
  await search.click()
  await toggle.click()
  await expect(inputs.nth(1)).toBeFocused()
  await orcaPage.keyboard.type('returned-to-second-pane')
  await expect.poll(() => getTerminalContent(orcaPage)).toContain('returned-to-second-pane')

  await toggle.click()
  await search.click()
  await inputs.first().click()
  await pressShortcut(orcaPage, 'l')
  await expect(search).toBeHidden()
  await expect(inputs.first()).toBeFocused()
})

test('sidebar shortcuts preserve terminal focus without changing search Escape behavior', async ({
  orcaPage
}) => {
  const input = orcaPage.getByRole('textbox', { name: 'Terminal input', exact: true })
  await input.click()
  await pressShortcut(orcaPage, 'l')
  const search = orcaPage.getByRole('textbox', { name: 'Find files', exact: true })
  await expect(search).toBeVisible()
  await expect(input).toBeFocused()
  await pressShortcut(orcaPage, 'l')
  await expect(search).toBeHidden()
  await expect(input).toBeFocused()

  await pressShortcut(orcaPage, 'f', { shift: true })
  const contentsSearch = orcaPage.getByRole('textbox', { name: 'Search files', exact: true })
  await expect(contentsSearch).toBeFocused()
  await contentsSearch.fill('focus')
  await orcaPage.keyboard.press('Escape')
  await expect(contentsSearch).toHaveValue('')
  await expect(contentsSearch).not.toBeFocused()
})

test('sidebar close returns to the markdown editor and leaves a newly focused dialog alone', async ({
  orcaPage
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const file = await createMarkdownFixture(
    context,
    'sidebar-focus',
    'note',
    testInfo.workerIndex,
    '# Focus note\n'
  )
  await openMarkdownFixture(orcaPage, context, file)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await editor.click()
  const toggle = orcaPage.getByRole('button', { name: 'Toggle right sidebar', exact: true })
  await toggle.click()
  await orcaPage.getByRole('textbox', { name: 'Find files', exact: true }).fill('note')
  await toggle.click()
  await expect(editor).toBeFocused()
  await orcaPage.keyboard.type('editor-restored')
  await expect(editor).toContainText('editor-restored')

  await toggle.click()
  await orcaPage.getByRole('textbox', { name: 'Find files', exact: true }).click()
  await orcaPage
    .getByRole('button', { name: 'Search worktrees and browser tabs', exact: true })
    .click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const focusedInput = dialog.locator('input:focus')
  await expect(focusedInput).toHaveCount(1)
  await orcaPage.evaluate(() => window.__store!.getState().setRightSidebarOpen(false))
  await orcaPage.keyboard.type('dialog-keeps-focus')
  await expect(dialog.locator('input')).toHaveValue('dialog-keeps-focus')
})
