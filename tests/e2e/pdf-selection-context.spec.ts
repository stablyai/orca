import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { expect } from './helpers/orca-app'
import { openStubChat, test, SUPPORTED } from './helpers/structured-claude-stub'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'

test.skip(!SUPPORTED, 'The existing agent stub requires POSIX')

test('PDF selection opens the agent picker and becomes an unsent chat draft', async ({
  orcaPage,
  electronApp,
  claudeStub,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  const chat = await openStubChat(orcaPage, claudeStub.command)
  await chat.composer.fill('Existing draft')
  const filePath = path.join(seededRepoPath, 'paper.pdf')
  writeFileSync(filePath, createPdfFindFixture())
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store!.getState()
    state.openFile({
      filePath,
      relativePath: 'paper.pdf',
      worktreeId: state.activeWorktreeId!,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  const line = orcaPage
    .locator('.pdfViewer .textLayer span')
    .filter({ hasText: /^needle result 1$/ })
  await expect(line).toBeVisible()
  await line.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
  })
  const add = orcaPage.getByRole('button', { name: 'Add to chat', exact: true })
  await expect(add).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('after-selection.png')
  })
  await add.click()
  const menu = orcaPage.getByRole('menu')
  await expect(menu).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('agent-picker.png')
  })
  await menu.getByRole('menuitem').first().click()
  await expect(chat.composer).toHaveText('Existing draft > paper.pdf (page 1) > needle result 1', {
    useInnerText: true
  })
  await expect(chat.reply).toHaveCount(0)
  await expect(chat.send).toBeEnabled()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('unsent-draft.png')
  })
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows).toEqual([{ visible: false, focused: false }])
})
