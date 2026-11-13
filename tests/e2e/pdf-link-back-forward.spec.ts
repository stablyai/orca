import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  PDF_INTERNAL_LINKS,
  PDF_INTERNAL_LINK_PAGE_COUNT,
  PDF_INTERNAL_LINK_SECOND_TARGET_PAGE,
  PDF_INTERNAL_LINK_TARGET_PAGE,
  createPdfInternalLinkFixture
} from './helpers/pdf-internal-link-fixture'

const SHOTS_DIR = process.env.ORCA_PDF_LINK_HISTORY_SHOTS_DIR
const IS_MAC = process.platform === 'darwin'
const BACK_KEY = IS_MAC ? 'Meta+BracketLeft' : 'Alt+ArrowLeft'
const FORWARD_KEY = IS_MAC ? 'Meta+BracketRight' : 'Alt+ArrowRight'

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

async function openFixture(
  page: Page,
  seededRepoPath: string,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<{ links: (pageNumber: number) => Locator; back: Locator; forward: Locator }> {
  const filePath = path.join(seededRepoPath, 'pdf-internal-link.pdf')
  writeFileSync(filePath, createPdfInternalLinkFixture())
  registerCleanup(async () => rmSync(filePath, { force: true }))
  await page.evaluate((filePath) => {
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
  await expect(page.locator('.pdfViewer .page')).toHaveCount(PDF_INTERNAL_LINK_PAGE_COUNT)
  const links = (pageNumber: number): Locator =>
    page.locator(`.pdfViewer .page[data-page-number="${pageNumber}"] .annotationLayer a`)
  await expect(links(1)).toHaveCount(3)
  await expect.poll(() => readCurrentPage(page)).toBe(1)
  return {
    links,
    back: page.locator('[data-pdf-link-history="back"]'),
    forward: page.locator('[data-pdf-link-history="forward"]')
  }
}

test('a PDF link jump can be undone and redone from the toolbar, keyboard and mouse', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const { links, back, forward } = await openFixture(
    orcaPage,
    seededRepoPath,
    registerPostElectronShutdownCleanup
  )
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  const startScrollTop = await readScrollTop(orcaPage)
  await shot(orcaPage, '1-before-link')

  await links(1).nth(PDF_INTERNAL_LINKS.toTargetPage).click()
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
  await orcaPage.keyboard.press(FORWARD_KEY)
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
  await orcaPage.keyboard.press(BACK_KEY)
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)

  // Playwright cannot press side buttons, so dispatch the event the OS would deliver.
  await orcaPage
    .locator('.pdfViewer')
    .dispatchEvent('mouseup', { button: 4, bubbles: true, cancelable: true })
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
})

test('history skips dead links, records page actions, and keeps every step of quick repeats', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const { links, back, forward } = await openFixture(
    orcaPage,
    seededRepoPath,
    registerPostElectronShutdownCleanup
  )

  // Two jumps: page 1 → page 5 → page 3.
  await links(1).nth(PDF_INTERNAL_LINKS.toTargetPage).click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)
  await links(PDF_INTERNAL_LINK_TARGET_PAGE).first().click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_SECOND_TARGET_PAGE)

  // Two Backs in one task, before pdf.js reports the first scroll: each must leave from where
  // the previous one landed, and page 3's late text-layer focus must not pull the reader back.
  await back.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)
  // ast-grep-ignore: test-no-real-time-wait -- the claim is that no late focus scroll happens over a window after landing
  await orcaPage.waitForTimeout(500)
  expect(await readCurrentPage(orcaPage)).toBe(1)
  await forward.focus()
  await orcaPage.keyboard.press(FORWARD_KEY)
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_TARGET_PAGE)

  // Scrolling by hand is not history; return to page 1 with Forward still pending.
  await orcaPage.evaluate(() => {
    const container = document.querySelector('.pdfViewer')?.parentElement
    if (container) {
      container.scrollTop = 0
    }
  })
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)
  await expect(forward).toBeEnabled()

  // A link pdf.js cannot resolve moves nothing, so Forward must survive it.
  const rejected = orcaPage.waitForEvent('console', (message) =>
    message.text().includes('no-such-destination')
  )
  await links(1).nth(PDF_INTERNAL_LINKS.unresolved).click()
  await rejected
  expect(await readCurrentPage(orcaPage)).toBe(1)
  await expect(forward).toBeEnabled()

  // The PDF's own LastPage action is a jump too, and replaces the pending Forward.
  await links(1).nth(PDF_INTERNAL_LINKS.lastPage).click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(PDF_INTERNAL_LINK_PAGE_COUNT)
  await expect(forward).toBeDisabled()
  await back.click()
  await expect.poll(() => readCurrentPage(orcaPage)).toBe(1)
})
