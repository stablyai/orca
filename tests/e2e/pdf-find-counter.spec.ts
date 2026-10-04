import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { pressShortcut } from './helpers/shortcuts'

test('PDF counter follows navigation, new queries, and reopening', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const filePath = path.join(seededRepoPath, 'pdf-find-fixture.pdf')
  writeFileSync(filePath, createPdfFindFixture())
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-find-fixture.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  await expect(orcaPage.locator('.pdfViewer .page')).toHaveCount(3)
  await expect(orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
    'needle result 1'
  )
  await pressShortcut(orcaPage, 'f')
  const input = orcaPage.getByPlaceholder('Find in page...')
  const bar = input.locator('..')
  const selected = orcaPage.locator('.pdfViewer .highlight.selected')
  const observations: object[] = []
  const capture = async (name: string, counter: string, selectedText?: string): Promise<void> => {
    if (selectedText) {
      await expect(selected).toHaveCount(1)
      await expect(selected.locator('..')).toHaveText(selectedText)
    }
    await expect.soft(bar).toContainText(counter, { timeout: 1000 })
    observations.push({
      name,
      expected: counter,
      actual: await bar.innerText(),
      selected: await selected.locator('..').allTextContents()
    })
    await orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  }
  await input.fill('needle')
  await capture('initial', '1 of 6', 'needle result 1')
  await bar.getByTitle('Next match', { exact: true }).click()
  await capture('next', '2 of 6', 'needle result 2')
  await input.press('Enter')
  await capture('enter', '3 of 6', 'needle result 3')
  await input.press('Shift+Enter')
  await capture('shift-enter', '2 of 6', 'needle result 2')
  await bar.getByTitle('Previous match', { exact: true }).click()
  await capture('previous', '1 of 6', 'needle result 1')
  await bar.getByTitle('Previous match', { exact: true }).click()
  await capture('wrap-previous', '6 of 6', 'needle result 6')
  await input.press('Enter')
  await capture('wrap-next', '1 of 6', 'needle result 1')
  await input.fill('beacon')
  await capture('query-change', '1 of 2', 'beacon alternate query')
  await input.fill('absentword')
  await expect(selected).toHaveCount(0)
  await capture('no-results', 'No matches')
  await input.fill('needle')
  await capture('query-restored', '1 of 6', 'needle result 1')
  await input.fill('beacon')
  await input.fill('absentword')
  await input.fill('needle')
  // The final query is unchanged; let PDF.js's 250ms debounce finish before stepping.
  await orcaPage.waitForTimeout(350)
  await capture('rapid-query', '1 of 6', 'needle result 1')
  await bar.getByTitle('Next match', { exact: true }).click()
  await capture('before-close', '2 of 6', 'needle result 2')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(selected).toHaveCount(0)
  await pressShortcut(orcaPage, 'f')
  await capture('reopened', '1 of 6', 'needle result 1')
  await input.press('Enter')
  await capture('reopened-enter', '2 of 6', 'needle result 2')
  const windows = await electronApp.evaluate(({ BrowserWindow, app }) => ({
    appPath: app.getAppPath(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(windows.windows.every((window) => !window.focused)).toBe(true)
  const headful =
    process.env.ORCA_E2E_FORCE_HEADFUL === '1' || testInfo.project.metadata.orcaHeadful === true
  if (process.env.ORCA_BACKGROUND_LAUNCH === '1' || !headful) {
    expect(windows.windows.every((window) => !window.visible)).toBe(true)
  }
  writeFileSync(
    testInfo.outputPath('observations.json'),
    JSON.stringify({ windows, observations }, null, 2)
  )
})

test.describe('PDF in a folder workspace', () => {
  test.use({ seedTestRepo: false })

  test('finds and navigates a PDF without a Git repository', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const folderPath = mkdtempSync(path.join(os.tmpdir(), 'orca-pdf-folder-'))
    const filePath = path.join(folderPath, 'pdf-find-fixture.pdf')
    writeFileSync(filePath, createPdfFindFixture())
    registerPostElectronShutdownCleanup(async () =>
      rmSync(folderPath, { recursive: true, force: true })
    )
    await orcaPage.evaluate(
      async ({ folderPath, filePath }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing fixture store')
        }
        const group = await window.api.projectGroups.create({
          name: 'PDF fixture',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups()
        const folder = await state.createFolderWorkspace({
          projectGroupId: group.id,
          name: 'PDF documents',
          folderPath
        })
        if (!folder) {
          throw new Error('Missing fixture folder')
        }
        const worktreeId = `folder:${folder.id}`
        state.setActiveWorktree(worktreeId)
        state.openFile({
          filePath,
          relativePath: 'pdf-find-fixture.pdf',
          worktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { folderPath, filePath }
    )
    await expect(orcaPage.locator('.pdfViewer .page')).toHaveCount(3)
    await expect(orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
      'needle result 1'
    )
    await pressShortcut(orcaPage, 'f')
    const input = orcaPage.getByPlaceholder('Find in page...')
    await input.fill('needle')
    await expect(input.locator('..')).toContainText('1 of 6')
    const selected = orcaPage.locator('.pdfViewer .highlight.selected').locator('..')
    await expect(selected).toHaveText('needle result 1')
    await input.press('Enter')
    await expect(input.locator('..')).toContainText('2 of 6')
    await expect(selected).toHaveText('needle result 2')
    await orcaPage.screenshot({ path: testInfo.outputPath('folder-next.png') })
  })
})
