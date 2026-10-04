import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createPdfParagraphFixture } from './helpers/pdf-paragraph-fixture'

// The fixture is US Letter: a 20pt "Results" heading at baseline 90, a four-line paragraph at
// baselines 130–172, and an indented paragraph at 186–200 (PDF points below the top edge).
const PAGE_WIDTH_PT = 612

async function pdfToClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('.pdfViewer .page[data-page-number="1"]').boundingBox()
  if (!box) {
    throw new Error('PDF page is not laid out')
  }
  const scale = box.width / PAGE_WIDTH_PT
  return { x: box.x + x * scale, y: box.y + y * scale }
}

async function dragPdfBox(
  page: Page,
  [left, top, right, bottom]: [number, number, number, number],
  { shift = false } = {}
): Promise<void> {
  const from = await pdfToClient(page, left, top)
  const to = await pdfToClient(page, right, bottom)
  if (shift) {
    await page.keyboard.down('Shift')
  }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  if (shift) {
    await page.keyboard.up('Shift')
  }
}

test('PDF annotate mode: boxes, paragraph clicks and pins reach the agent prompt', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const filePath = path.join(seededRepoPath, 'pdf-annotate-fixture.pdf')
  writeFileSync(filePath, createPdfParagraphFixture())
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  // Why: the host OS locale drives the UI language; pin English so locators are stable.
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'en', theme: 'light' })
  )
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-annotate-fixture.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  await expect(orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
    'The first paragraph'
  )
  const shot = (name: string) => orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  const annotate = orcaPage.getByRole('button', { name: 'Annotate PDF' })
  const card = orcaPage.getByRole('dialog', { name: 'Add PDF annotation' })
  const badges = orcaPage.locator('[data-pdf-annotation-badge]')

  await annotate.click()
  await expect(annotate).toHaveAttribute('aria-pressed', 'true')

  // A dragged box, then Shift+click adds a whole paragraph to the same comment.
  await dragPdfBox(orcaPage, [66, 70, 170, 98])
  await expect(card).toContainText('p.1 "Results"')
  const secondParagraph = await pdfToClient(orcaPage, 250, 197)
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(secondParagraph.x, secondParagraph.y)
  await orcaPage.keyboard.up('Shift')
  await expect(card).toContainText('p.1 (2 areas) "Results … A second paragraph')
  await expect(card).toHaveCSS('opacity', '1')
  await shot('01-box-plus-paragraph-pending')
  await card.getByRole('textbox').fill('Retitle the section to match this paragraph')
  await card.getByRole('button', { name: /Add/ }).click()
  await expect(card).toHaveCount(0)
  await expect(orcaPage.getByText('1 annotation', { exact: true })).toBeVisible()
  // Annotate mode stays armed after adding, like Design Mode.
  await expect(annotate).toHaveAttribute('aria-pressed', 'true')

  // A plain click on any line picks its whole paragraph.
  const firstParagraph = await pdfToClient(orcaPage, 200, 155)
  await orcaPage.mouse.click(firstParagraph.x, firstParagraph.y)
  await expect(card).toContainText('p.1 "The first paragraph opens')
  await card.getByRole('textbox').fill('Split this into two sentences')
  await card.getByRole('button', { name: /Add/ }).click()

  // A click where there is no text drops a pin.
  const margin = await pdfToClient(orcaPage, 300, 400)
  await orcaPage.mouse.click(margin.x, margin.y)
  await expect(card).toContainText('p.1')
  await card.getByRole('textbox').fill('Add a figure here')
  await card.getByRole('button', { name: /Add/ }).click()
  await expect(orcaPage.getByText('3 annotations', { exact: true })).toBeVisible()
  await expect(badges).toHaveText(['1', '2', '3'])
  await shot('02-three-annotations')

  await orcaPage.getByRole('button', { name: 'Copy' }).click()
  const prompt = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  writeFileSync(testInfo.outputPath('prompt.md'), prompt)
  expect(prompt).toContain('## PDF Feedback: pdf-annotate-fixture.pdf')
  expect(prompt).toContain(
    '**Text in areas (approximate):** "Results … A second paragraph starts with an indent, which is how typeset papers mark a new paragraph without extra space."'
  )
  expect(prompt).toContain(
    '**Text in areas (approximate):** "The first paragraph opens the section and runs across several full lines so that a click anywhere inside it should pick the whole block at once and hand the agent every line of it together rather than just one text run of the paragraph."'
  )
  expect(prompt).toContain('**Feedback:** Add a figure here')
  expect(prompt.match(/\*\*Position:\*\*/g)).toHaveLength(1)

  const before = await badges.first().boundingBox()
  await orcaPage.getByTitle('Zoom in').click()
  await expect.poll(async () => (await badges.first().boundingBox())?.y).not.toBe(before?.y)
  await shot('03-zoomed')

  // Visual proof only: the overlay uses theme tokens, so dark mode needs no separate logic.
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await dragPdfBox(orcaPage, [66, 70, 170, 98])
  await expect(card).toHaveCSS('opacity', '1')
  await shot('04-dark-pending')
  // Escape on the open card only dismisses the card; the mode stays armed.
  await orcaPage.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(annotate).toHaveAttribute('aria-pressed', 'true')

  await orcaPage.keyboard.press('Escape')
  await expect(annotate).toHaveAttribute('aria-pressed', 'false')

  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows.every((window) => !window.focused)).toBe(true)
})

test('PDF annotate mode: boxes on a rotated page keep their size', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const filePath = path.join(seededRepoPath, 'pdf-annotate-rotated.pdf')
  writeFileSync(filePath, createPdfParagraphFixture(undefined, { rotate: 90 }))
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'en', theme: 'light' })
  )
  await orcaPage.evaluate((filePath) => {
    const state = window.__store!.getState()
    state.openFile({
      filePath,
      relativePath: 'pdf-annotate-rotated.pdf',
      worktreeId: state.activeWorktreeId!,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  const page = orcaPage.locator('.pdfViewer .page[data-page-number="1"]')
  await expect(page.locator('.textLayer')).toContainText('The first paragraph')
  await orcaPage.getByRole('button', { name: 'Annotate PDF' }).click()

  // Drag a box across the middle of the rotated page, in screen space.
  const box = (await page.boundingBox())!
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 }
  const to = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 }
  await orcaPage.mouse.move(from.x, from.y)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(to.x, to.y, { steps: 6 })
  await orcaPage.mouse.up()
  const card = orcaPage.getByRole('dialog', { name: 'Add PDF annotation' })
  await card.getByRole('textbox').fill('Rotated box')
  await card.getByRole('button', { name: /Add/ }).click()

  // The committed outline covers the dragged area instead of collapsing to a negative size.
  const outline = (await orcaPage.locator('[data-pdf-annotation-region]').first().boundingBox())!
  expect(Math.abs(outline.x - from.x)).toBeLessThan(3)
  expect(Math.abs(outline.y - from.y)).toBeLessThan(3)
  expect(Math.abs(outline.width - (to.x - from.x))).toBeLessThan(3)
  expect(Math.abs(outline.height - (to.y - from.y))).toBeLessThan(3)
  const badge = (await orcaPage.locator('[data-pdf-annotation-badge]').first().boundingBox())!
  expect(Math.abs(badge.x + badge.width / 2 - from.x)).toBeLessThan(3)
  await orcaPage.screenshot({ path: testInfo.outputPath('rotated-box.png') })
})
