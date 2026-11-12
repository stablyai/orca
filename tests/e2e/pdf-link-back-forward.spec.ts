import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  PDF_INTERNAL_LINK_PAGE_COUNT,
  PDF_INTERNAL_LINK_TARGET_PAGE,
  createPdfInternalLinkFixture
} from './helpers/pdf-internal-link-fixture'

const SHOTS_DIR = process.env.ORCA_PDF_LINK_HISTORY_SHOTS_DIR

/** The page whose box contains the scroll container's top edge. */
function readCurrentPage(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const container = document.querySelector('.pdfViewer')?.parentElement
    if (!container) {
      return null
    }
    const probe = container.getBoundingClientRect().top + 8
    for (const element of Array.from(document.querySelectorAll('.pdfViewer .page'))) {
      const box = element.getBoundingClientRect()
      if (box.top <= probe && box.bottom > probe) {
        return Number(element.getAttribute('data-page-number'))
      }
    }
    return null
  })
}

function readScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.pdfViewer')?.parentElement?.scrollTop ?? -1)
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) {
    return
  }
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) })
}

test('a PDF link jump can be undone and redone from the toolbar, keyboard and mouse', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const filePath = path.join(seededRepoPath, 'pdf-internal-link.pdf')
  writeFileSync(filePath, createPdfInternalLinkFixture())
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-internal-link.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)

  await expect(orcaPage.locator('.pdfViewer .page')).toHaveCount(PDF_INTERNAL_LINK_PAGE_COUNT)
  const link = orcaPage.locator('.pdfViewer .page[data-page-number="1"] .annotationLayer a')
  await expect(link).toBeVisible()
  const back = orcaPage.locator('[data-pdf-link-history="back"]')
  const forward = orcaPage.locator('[data-pdf-link-history="forward"]')
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)
  const startScrollTop = await readScrollTop(orcaPage)
  await shot(orcaPage, '1-before-link')

  await link.click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
  await expect(back).toBeEnabled()
  await expect(forward).toBeDisabled()
  await shot(orcaPage, '2-after-link')

  await back.click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)
  await expect
    .poll(async () => Math.abs((await readScrollTop(orcaPage)) - startScrollTop))
    .toBeLessThan(2)
  await expect(back).toBeDisabled()
  await expect(forward).toBeEnabled()
  await shot(orcaPage, '3-after-back')

  // Focus stays on the toolbar button, inside the PDF that owns the keys.
  const isMac = process.platform === 'darwin'
  await orcaPage.keyboard.press(isMac ? 'Meta+BracketRight' : 'Alt+ArrowRight')
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
  await orcaPage.keyboard.press(isMac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft')
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)

  // Playwright cannot press side buttons, so dispatch the event the OS would deliver.
  await orcaPage
    .locator('.pdfViewer')
    .dispatchEvent('mouseup', { button: 4, bubbles: true, cancelable: true })
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
})
