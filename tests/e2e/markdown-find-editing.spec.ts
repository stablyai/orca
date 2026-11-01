import type { Locator, Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const TARGET_TEXT = 'Editing target paragraph keeps the pointer position and viewport.'
const MARKDOWN = [
  '# Find and pointer editing',
  'Needle remains at the beginning.',
  ...Array.from({ length: 100 }, (_, index) =>
    index === 70 ? TARGET_TEXT : `Paragraph ${index} provides room to scroll through the document.`
  ),
  'Needle remains at the end.'
].join('\n\n')
const TABLE_MARKDOWN = MARKDOWN.replace(
  TARGET_TEXT,
  `| Name | Value |\n| --- | --- |\n| Target | ${TARGET_TEXT} |`
)

async function textPoint(paragraph: Locator, offset: number) {
  return paragraph.evaluate((element, offset) => {
    const text = element.firstChild
    if (!(text instanceof Text)) {
      throw new Error('Expected a plain-text paragraph')
    }
    const range = document.createRange()
    range.setStart(text, offset)
    range.collapse(true)
    const bounds = range.getBoundingClientRect()
    return { x: bounds.left, y: bounds.top + bounds.height / 2 }
  }, offset)
}

async function readParagraphSelection(paragraph: Locator) {
  return paragraph.evaluate((element) => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) {
      return null
    }
    if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
      return null
    }
    const start = document.createRange()
    start.selectNodeContents(element)
    start.setEnd(selection.anchorNode, selection.anchorOffset)
    const end = document.createRange()
    end.selectNodeContents(element)
    end.setEnd(selection.focusNode, selection.focusOffset)
    return {
      from: Math.min(start.toString().length, end.toString().length),
      to: Math.max(start.toString().length, end.toString().length),
      text: selection.toString()
    }
  })
}

async function centerParagraph(paragraph: Locator): Promise<void> {
  await paragraph.evaluate((element) => element.scrollIntoView({ block: 'center' }))
}

async function pointAtParagraph(page: Page, paragraph: Locator, drag: boolean) {
  const start = await textPoint(paragraph, 8)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  if (drag) {
    const end = await textPoint(paragraph, 24)
    await page.mouse.move(end.x, end.y, { steps: 12 })
  }
  // Tiptap focus commands can schedule a stale-selection scroll for the next frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.mouse.up()
  const selection = await readParagraphSelection(paragraph)
  expect(selection).not.toBeNull()
  if (!selection) {
    throw new Error('Pointer selection left the intended paragraph')
  }
  if (drag) {
    expect(selection.text).toBe('target paragraph')
  } else {
    expect(selection.from).toBe(selection.to)
  }
  return selection
}

test.beforeEach(async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
})

for (const interaction of ['click', 'drag'] as const) {
  test(`keeps Find open while a document ${interaction} edits at the pointer position`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-markdown-find-editing',
      `find-${interaction}`,
      testInfo.workerIndex,
      MARKDOWN
    )
    registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
    await openMarkdownFixture(orcaPage, context, filePath)
    const editor = await waitForRichMarkdownEditor(orcaPage)
    const paragraph = editor.locator('p').filter({ hasText: 'Editing' })
    const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
    await editor.locator('p').first().click()
    await pressShortcut(orcaPage, 'f')
    const search = orcaPage.getByRole('textbox', { name: 'Find in rich markdown editor' })
    await expect(search).toBeFocused()
    await search.fill('Needle')
    await orcaPage.getByRole('button', { name: 'Match case', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Match whole word', exact: true }).click()
    await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/2')
    await centerParagraph(paragraph)
    const originalScroll = await viewport.evaluate((element) => element.scrollTop)
    const selection = await pointAtParagraph(orcaPage, paragraph, interaction === 'drag')

    // Separate key events allow document updates to expose a caret reset between characters.
    await orcaPage.keyboard.type('xy', { delay: 100 })
    await orcaPage.screenshot({ path: testInfo.outputPath('find-document-edit.png') })
    await expect(paragraph).toHaveText(
      `${TARGET_TEXT.slice(0, selection.from)}xy${TARGET_TEXT.slice(selection.to)}`
    )
    await expect(editor.locator('p').first()).toHaveText('Needle remains at the beginning.')
    await expect
      .poll(() => readParagraphSelection(paragraph))
      .toEqual({
        from: selection.from + 2,
        to: selection.from + 2,
        text: ''
      })
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeCloseTo(originalScroll, 0)
    await expect(search).toBeVisible()
    await expect(search).toHaveValue('Needle')
    await expect(orcaPage.getByRole('button', { name: 'Match case', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(
      orcaPage.getByRole('button', { name: 'Match whole word', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/2')
  })

  test(`keeps the scrolled table and ${interaction} selection after switching Source to Rich`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      '.orca-e2e-markdown-find-editing',
      `source-${interaction}`,
      testInfo.workerIndex,
      TABLE_MARKDOWN
    )
    registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
    await openMarkdownFixture(orcaPage, context, filePath)
    await waitForRichMarkdownEditor(orcaPage)
    await orcaPage.getByRole('radio', { name: 'Source', exact: true }).click()
    await expect(orcaPage.locator('.monaco-editor')).toBeVisible()
    await orcaPage.getByRole('radio', { name: 'Rich Editor', exact: true }).click()
    const editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor).not.toBeFocused()
    const paragraph = editor.locator('td p').filter({ hasText: 'Editing' })
    const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
    await centerParagraph(paragraph)
    const originalScroll = await viewport.evaluate((element) => element.scrollTop)
    const selection = await pointAtParagraph(orcaPage, paragraph, interaction === 'drag')
    await expect(editor).toBeFocused()
    await expect(paragraph).toHaveText(TARGET_TEXT)
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeCloseTo(originalScroll, 0)
    const tab = orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: path.basename(filePath) })
      .last()
    await expect(tab.locator('span.rounded-full')).toHaveCount(0)
    await expect(tab.getByRole('button', { name: 'Close tab' })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('source-rich-table-selection.png') })
    await orcaPage.keyboard.type('xy', { delay: 100 })
    await orcaPage.screenshot({ path: testInfo.outputPath('source-rich-pointer-edit.png') })
    await expect(paragraph).toHaveText(
      `${TARGET_TEXT.slice(0, selection.from)}xy${TARGET_TEXT.slice(selection.to)}`
    )
    await expect
      .poll(() => readParagraphSelection(paragraph))
      .toEqual({
        from: selection.from + 2,
        to: selection.from + 2,
        text: ''
      })
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeCloseTo(originalScroll, 0)
  })
}
