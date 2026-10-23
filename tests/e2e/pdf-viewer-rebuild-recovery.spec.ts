import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'

const ERROR_TEXT = 'Failed to load PDF preview'

async function settleAndCapture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // Past the editor's 75ms external-reload debounce and the pdf.js parse.
  await page.waitForTimeout(1500)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
}

test('PDF preview recovers after repeated failed refreshes without showing old pages', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const filePath = path.join(seededRepoPath, 'rebuilt.pdf')
  const finished = createPdfFindFixture()
  const halfWritten = finished.subarray(0, Math.floor(finished.length / 2))
  const pages = orcaPage.locator('.pdfViewer .page')
  const error = orcaPage.getByText(ERROR_TEXT)
  writeFileSync(filePath, halfWritten)
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'rebuilt.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  // Nothing good has loaded yet, so the broken file shows the error.
  await expect(error).toBeVisible()

  writeFileSync(filePath, finished)
  await settleAndCapture(orcaPage, testInfo, '1-finished-after-error')
  await expect(error).toBeHidden()
  await expect(pages).toHaveCount(3)

  // A failed refresh must not leave pages from the previous contents visible.
  const firstPage = pages.first().locator('.textLayer')
  writeFileSync(filePath, halfWritten)
  await expect(error).toBeVisible()
  await expect(pages).toHaveCount(0)
  await settleAndCapture(orcaPage, testInfo, '2-failed-refresh')

  writeFileSync(filePath, '')
  await expect(error).toBeVisible()
  await expect(pages).toHaveCount(0)

  // A distinct finished build, so the swap to the new document is observable.
  writeFileSync(filePath, createPdfFindFixture({ title: 'Next build' }))
  await expect(firstPage).toContainText('Next build - page 1')
  await expect(error).toBeHidden()
  await orcaPage.screenshot({ path: testInfo.outputPath('3-next-build.png') })
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
})
