import { readFileSync } from 'node:fs'
import { seedMultiwindowSearch } from './multiwindow-search-fixture'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './orca-app'
import { openWorkspaceWindow, expectHiddenWorkspaceWindows } from './workspace-window'
import { worktreeRowSurface } from '../worktree-row-locators'
import { reloadSecondaryDraft } from './multiwindow-draft-reload'

async function jump(page: Page, query: string) {
  await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  await page.getByRole('combobox').fill(query)
}

async function layoutAction(page: Page, label: string) {
  await page
    .locator('[data-pane-id][data-current="true"]')
    .getByRole('button', { name: 'Window actions' })
    .click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

export async function multiwindowSearchJourney(
  { electronApp, orcaPage }: { electronApp: ElectronApplication; orcaPage: Page },
  testInfo: TestInfo
) {
  test.setTimeout(240_000)
  const errors: string[] = []
  orcaPage.on('pageerror', (error) => errors.push(error.message))
  const { fixture, filePath, notesPath } = await seedMultiwindowSearch(orcaPage, testInfo)
  await worktreeRowSurface(orcaPage, fixture.original).click()
  await orcaPage.locator(`[data-tab-id="${fixture.terminalId}"]`).click()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ original, terminalId }) =>
          window.__store!.getState().tabsByWorktree[original]!.find((tab) => tab.id === terminalId)!
            .ptyId,
        fixture
      )
    )
    .toBeTruthy()
  const ptyId = await orcaPage.evaluate(
    ({ original, terminalId }) =>
      window.__store!.getState().tabsByWorktree[original]!.find((tab) => tab.id === terminalId)!
        .ptyId,
    fixture
  )
  const secondary = await openWorkspaceWindow(electronApp)
  secondary.on('pageerror', (error) => errors.push(error.message))
  await worktreeRowSurface(secondary, fixture.folderId).click()
  await secondary.locator('[data-tab-id]').filter({ hasText: 'search-draft.md' }).click()
  const editor = secondary.locator('.rich-markdown-editor:visible')
  await editor.click()
  await secondary.keyboard.press('ControlOrMeta+End')
  await secondary.keyboard.press('Enter')
  await secondary.keyboard.type('PANE4 UNSAVED SENTINEL')
  await expect(editor).toContainText('PANE4 UNSAVED SENTINEL')
  await expectHiddenWorkspaceWindows(electronApp)
  const secondaryId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
  const originalLayout = await orcaPage.evaluate(() => window.__store!.getState().windowPaneLayout!)
  await jump(orcaPage, 'search-draft')
  const draftRow = orcaPage
    .locator(`[data-value^="workspace-view:${secondaryId}:"]`)
    .filter({ hasText: 'search-draft.md' })
  await expect(draftRow).toBeVisible()
  await draftRow.hover()
  await orcaPage.getByRole('combobox').press('Enter')
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await expectHiddenWorkspaceWindows(electronApp)
  expect(await orcaPage.evaluate(() => window.__store!.getState().windowPaneLayout)).toEqual(
    originalLayout
  )
  await expect(editor).toContainText('PANE4 UNSAVED SENTINEL')
  await jump(orcaPage, 'search-draft')
  await draftRow.getByRole('button', { name: 'Open Here', exact: true }).focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.locator('.rich-markdown-editor:visible')).toContainText(
    'PANE4 UNSAVED SENTINEL'
  )
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(1)
  await jump(orcaPage, 'search-draft')
  await draftRow.getByRole('button', { name: 'Open Beside', exact: true }).focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(2)
  await jump(orcaPage, 'search-draft')
  const placements = orcaPage
    .locator('[data-value^="workspace-view:"]')
    .filter({ hasText: 'search-draft.md' })
  const primaryId = await orcaPage.evaluate(() => window.orcaWorkspaceViews!.ready())
  const titles = await electronApp.evaluate(
    ({ BrowserWindow }, ids) => ids.map((id) => BrowserWindow.fromId(id)!.getTitle()),
    [primaryId, secondaryId]
  )
  expect(titles[0]).toMatch(/^Orca/)
  expect(titles[1]).toBe(titles[0])
  await expect(placements).toHaveCount(3)
  await expect(placements.filter({ hasText: `${titles[0]} (${primaryId})` })).toHaveCount(2)
  await expect(placements.filter({ hasText: `${titles[1]} (${secondaryId})` })).toHaveCount(1)
  await expect(placements.filter({ hasText: 'Orca Web' })).toHaveCount(0)
  await orcaPage.getByRole('combobox').press('Home')
  await orcaPage.getByRole('combobox').press('ArrowDown')
  await expect(
    orcaPage.locator('[data-value^="workspace-view:"][data-selected="true"]')
  ).toHaveCount(1)
  await orcaPage.getByRole('dialog').screenshot({
    path: testInfo.outputPath('jump-repeated-native-editor-views.png'),
    animations: 'disabled'
  })
  await orcaPage.getByRole('combobox').press('Escape')
  const laterEditor = orcaPage.locator('.rich-markdown-editor:visible').last()
  await laterEditor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type('LATER EDIT SURVIVES UNDO')
  await layoutAction(orcaPage, 'Undo Layout Change')
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(1)
  await expect(orcaPage.locator('.rich-markdown-editor:visible')).toContainText(
    'LATER EDIT SURVIVES UNDO'
  )
  await orcaPage.getByRole('button', { name: 'Split Right', exact: true }).click()
  await layoutAction(orcaPage, 'Close Pane')
  await jump(orcaPage, 'Reopen Closed View')
  await orcaPage.locator('[data-value="quick-action:reopen-closed-view"]').click()
  await expect(orcaPage.locator('.rich-markdown-editor:visible')).toHaveCount(2)
  await expectHiddenWorkspaceWindows(electronApp)
  await expect(orcaPage.locator('.rich-markdown-editor:visible')).toContainText([
    'PANE4 UNSAVED SENTINEL',
    'PANE4 UNSAVED SENTINEL'
  ])
  expect(readFileSync(filePath, 'utf8')).not.toContain('PANE4 UNSAVED SENTINEL')
  await orcaPage
    .locator('[data-pane-id][data-current="true"]')
    .getByRole('button', { name: 'Expand Pane', exact: true })
    .click()
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(1)
  await jump(orcaPage, 'search-draft')
  await placements
    .filter({ hasText: `${titles[0]} (${primaryId})` })
    .filter({ hasText: 'Pane 1' })
    .click()
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(2)
  await expect(
    orcaPage.getByRole('region', { name: 'Workspace pane', exact: true }).first()
  ).toHaveAttribute('data-current', 'true')
  await expectHiddenWorkspaceWindows(electronApp)
  await orcaPage.locator('.rich-markdown-editor:visible').last().click()
  await reloadSecondaryDraft(secondary, filePath, testInfo)
  await expectHiddenWorkspaceWindows(electronApp)
  expect(
    await orcaPage.evaluate(
      ({ original, terminalId }) =>
        window.__store!.getState().tabsByWorktree[original]!.find((tab) => tab.id === terminalId)!
          .ptyId,
      fixture
    )
  ).toBe(ptyId)
  await jump(orcaPage, 'search-draft')
  await expect(
    orcaPage.locator('[data-value^="workspace-view:"]').filter({ hasText: 'search-draft.md' })
  ).toHaveCount(3)
  await expect(orcaPage.getByRole('dialog')).toBeVisible()
  await orcaPage.getByRole('combobox').press('Escape')
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  const combinedDraft = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    return state.editorDrafts[state.activeFileId!]
  })
  expect(combinedDraft).toContain('LATER EDIT SURVIVES UNDO')
  await secondary.getByRole('radio', { name: 'Source', exact: true }).click()
  await secondary.locator('.monaco-editor:visible').click()
  await secondary.keyboard.press('ControlOrMeta+A')
  await secondary.keyboard.type(combinedDraft)
  await expect
    .poll(() =>
      secondary.evaluate(() => {
        const state = window.__store!.getState()
        return state.editorDrafts[state.activeFileId!]
      })
    )
    .toBe(combinedDraft)
  await secondary.getByRole('radio', { name: 'Rich Editor', exact: true }).click()
  await expect(editor).toHaveText(
    await orcaPage.locator('.rich-markdown-editor:visible').last().innerText(),
    { useInnerText: true }
  )
  await secondary.evaluate(
    ({ notesPath, folderId }) => {
      const state = window.__store!.getState()
      const owner = state.openFiles.find((file) => file.worktreeId === folderId)!
      state.openFile({
        worktreeId: folderId,
        filePath: notesPath,
        relativePath: 'destination-notes.md',
        language: 'markdown',
        mode: 'edit',
        runtimeEnvironmentId: owner.runtimeEnvironmentId
      })
    },
    { notesPath, folderId: fixture.folderId }
  )
  await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText(
    'Destination notes'
  )
  await jump(orcaPage, 'PANE4 search shell')
  await orcaPage
    .locator(`[data-value^="workspace-view:${primaryId}:"]`)
    .filter({ hasText: 'PANE4 search shell' })
    .getByRole('button', { name: 'Open Here', exact: true })
    .click()
  const activePane = orcaPage.locator('[data-pane-id][data-current="true"]')
  await activePane.locator('[data-tab-id]').filter({ hasText: 'search-draft.md' }).click()
  await testInfo.attach('combine-drafts', {
    body: JSON.stringify(
      await Promise.all(
        [orcaPage, secondary].map((page) =>
          page.evaluate(() => ({
            layout: window.__store!.getState().windowPaneLayout,
            files: window.__store!.getState().openFiles,
            drafts: window.__store!.getState().editorDrafts,
            editors: [...document.querySelectorAll('.rich-markdown-editor')].map(
              (editor) => editor.textContent
            )
          }))
        )
      )
    ),
    contentType: 'application/json'
  })
  await expect(
    orcaPage.locator('[data-project-label]').filter({ hasText: 'search-folder' })
  ).toHaveCount(2)
  await activePane.getByRole('button', { name: 'Window actions' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Combine Windows as Panes', exact: true }).hover()
  await orcaPage
    .getByRole('menuitem')
    .filter({ hasText: `(${secondaryId})` })
    .click()
  await expect(secondary.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(
    3
  )
  await expect(orcaPage.locator('.rich-markdown-editor:visible')).toHaveCount(0)
  await expect(secondary.locator('.rich-markdown-editor:visible')).toHaveCount(3)
  await expectHiddenWorkspaceWindows(electronApp)
  const destinationTab = secondary
    .getByRole('region', { name: 'Workspace pane', exact: true })
    .first()
    .locator('[data-tab-id]')
    .filter({ hasText: 'destination-notes.md' })
  await destinationTab.focus()
  await destinationTab.press('Enter')
  const destinationEditor = secondary.locator('.rich-markdown-editor:visible').first()
  await destinationEditor.click()
  await secondary.keyboard.press('ControlOrMeta+End')
  await secondary.keyboard.press('Enter')
  await secondary.keyboard.type('COMBINE LATER DESTINATION EDIT')
  await layoutAction(secondary, 'Undo Layout Change')
  await expect(orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(2)
  await expect(secondary.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(
    1
  )
  await expect(secondary.locator('.rich-markdown-editor:visible')).toContainText(
    'COMBINE LATER DESTINATION EDIT'
  )
  await expect(orcaPage.locator('.rich-markdown-editor:visible').first()).toContainText(
    'LATER EDIT SURVIVES UNDO'
  )
  await expectHiddenWorkspaceWindows(electronApp)
  await secondary.screenshot({ path: testInfo.outputPath('automatic-draft-restore.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  expect(errors).toEqual([])
}
