import path from 'node:path'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import type { Locator, Page } from '@stablyai/playwright-test'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor,
  type ActiveWorktreeContext
} from './markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

// Why: expected values are the design's literals (60 em reading measure at a 14px document font).
const COLUMN_PX = 840
const COLUMN_AT_ZOOM_4_PX = 1080
const FIXTURE_DIRECTORY = '.orca-e2e-reading-width'
const LONG = 'Readable prose that wraps across several lines of the reading column. '.repeat(12)
const DOCUMENT = [
  '# Reading width',
  '',
  `FIRST ${LONG}`,
  '',
  `SECOND ${LONG}`,
  '',
  `THIRD ${LONG}`,
  ''
].join('\n')

type Rect = { left: number; right: number; top: number; bottom: number; width: number }

function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
  })
}

function expectSameRect(actual: Rect, expected: Rect): void {
  for (const key of ['left', 'right', 'top', 'bottom'] as const) {
    expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(1)
  }
}

// Free space on each side of the text inside the scroller's border box, plus its scrollbar width.
function freeSpace(text: Locator, scroller: string) {
  return text.evaluate((element, scrollerSelector) => {
    const scrollerElement = element.closest<HTMLElement>(scrollerSelector)!
    const style = getComputedStyle(scrollerElement)
    const borderLeft = Number.parseFloat(style.borderLeftWidth)
    const borderRight = Number.parseFloat(style.borderRightWidth)
    const box = scrollerElement.getBoundingClientRect()
    const r = element.getBoundingClientRect()
    return {
      left: r.left - box.left - borderLeft,
      right: box.right - borderRight - r.right,
      scrollbar: box.width - borderLeft - borderRight - scrollerElement.clientWidth
    }
  }, scroller)
}

async function layoutWindow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 1000 })
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.setSidebarOpen(false)
    state.setRightSidebarOpen(false)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

async function openPreview(
  page: Page,
  context: ActiveWorktreeContext,
  filePath: string
): Promise<Locator> {
  await page.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      window
        .__store!.getState()
        .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
    },
    {
      filePath,
      relativePath: path.relative(context.rootPath, filePath),
      worktreeId: context.worktreeId
    }
  )
  const preview = page.locator('.markdown-preview')
  await expect(preview.getByRole('heading', { name: 'Reading width', exact: true })).toBeVisible({
    timeout: 25_000
  })
  return preview
}

function previewParagraph(preview: Locator, marker: string): Locator {
  return preview.locator('.markdown-body p').filter({ hasText: marker }).first()
}

function previewBlock(page: Page, preview: Locator, marker: string): Locator {
  return preview
    .locator('.markdown-annotation-block')
    .filter({ has: page.locator('p', { hasText: marker }) })
    .first()
}

// Why: a single good sample can land between virtual remeasures; require it to hold across frames.
async function expectHolds(check: () => Promise<boolean>, samples = 8): Promise<void> {
  let streak = 0
  await expect
    .poll(
      async () => {
        streak = (await check()) ? streak + 1 : 0
        return streak
      },
      { intervals: [100] }
    )
    .toBeGreaterThanOrEqual(samples)
}

async function settledWidth(locator: Locator, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await rectOf(locator)).width - expected))
    .toBeLessThanOrEqual(1)
}

test.describe('Markdown reading width', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('R1 preview centres an 840px column that scales with zoom', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1920)
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'zoom',
        testInfo.workerIndex,
        DOCUMENT
      )
      const preview = await openPreview(orcaPage, context, filePath)
      const paragraph = previewParagraph(preview, 'FIRST')

      await settledWidth(paragraph, COLUMN_PX)
      const space = await freeSpace(paragraph, '.markdown-preview')
      expect(Math.abs(space.left - space.right)).toBeLessThanOrEqual(space.scrollbar + 1)

      await orcaPage.evaluate(() => window.__store!.getState().setEditorFontZoomLevel(4))
      await settledWidth(paragraph, COLUMN_AT_ZOOM_4_PX)
    } finally {
      await orcaPage.evaluate(() => window.__store!.getState().setEditorFontZoomLevel(0))
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('R2 rich editor keeps a centred 840px column beside its notes rail', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1920)
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'rich',
        testInfo.workerIndex,
        DOCUMENT
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)
      const first = editor.locator('p').filter({ hasText: 'FIRST' }).first()
      const second = editor.locator('p').filter({ hasText: 'SECOND' }).first()

      await first.click({ clickCount: 3 })
      await orcaPage.getByRole('button', { name: 'Add review note', exact: true }).click()
      await orcaPage.getByPlaceholder('Add note for the AI').fill('Reading width note')
      await orcaPage.getByPlaceholder('Add note for the AI').press('Enter')
      const card = orcaPage.locator('.rich-markdown-review-note-card').first()
      await expect(card).toBeVisible()

      await settledWidth(second, COLUMN_PX)
      const space = await freeSpace(second, '.rich-markdown-editor-shell')
      expect(Math.abs(space.left - space.right)).toBeLessThanOrEqual(space.scrollbar + 1)

      const shown = await rectOf(second)
      const cardRect = await rectOf(card)
      expect(Math.abs(cardRect.left - shown.right - 42)).toBeLessThanOrEqual(1)

      // Why: the side margin is editor padding, so a click there still places the caret.
      const pane = await rectOf(orcaPage.locator('.rich-markdown-editor-shell'))
      await orcaPage.mouse.click(pane.left + 200, (shown.top + shown.bottom) / 2)
      await expect
        .poll(() =>
          second.evaluate((element) => {
            const selection = window.getSelection()
            const editorRoot = element.closest('.ProseMirror')
            return Boolean(
              editorRoot?.contains(document.activeElement) &&
              selection?.anchorNode &&
              element.contains(selection.anchorNode)
            )
          })
        )
        .toBe(true)

      await orcaPage.getByRole('button', { name: 'Hide review notes', exact: true }).click()
      await expect(card).toBeHidden()
      expectSameRect(await rectOf(second), shown)
      await orcaPage.getByRole('button', { name: 'Show review notes', exact: true }).click()
      await expect(card).toBeVisible()
      expectSameRect(await rectOf(second), shown)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('R3 preview composer opens beside an unmoved 840px column', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1920)
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'preview',
        testInfo.workerIndex,
        DOCUMENT
      )
      const preview = await openPreview(orcaPage, context, filePath)
      const block = previewBlock(orcaPage, preview, 'FIRST')
      const paragraph = block.locator(':scope > p')

      await block.hover()
      const addNote = block.getByRole('button', { name: 'Add note', exact: true })
      await expect(addNote).toBeVisible()
      await settledWidth(paragraph, COLUMN_PX)
      const before = await rectOf(paragraph)

      await addNote.click()
      const composer = block.locator('.markdown-annotation-composer')
      await expect(composer).toBeVisible()
      const composerRect = await rectOf(composer)
      expect(Math.abs(composerRect.left - before.right - 32)).toBeLessThanOrEqual(1)
      expectSameRect(await rectOf(paragraph), before)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('R4 narrow preview with contents open keeps the text wide and the composer below it', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1000)
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'narrow',
        testInfo.workerIndex,
        DOCUMENT
      )
      await orcaPage.evaluate(() => window.__store!.getState().setMarkdownTocPanelWidth(240))
      const preview = await openPreview(orcaPage, context, filePath)
      await orcaPage.getByRole('button', { name: 'Table of Contents', exact: true }).click()
      const toc = orcaPage.getByRole('complementary', { name: 'Table of contents', exact: true })
      await expect(toc).toBeVisible()
      await expect.poll(async () => Math.round((await rectOf(toc)).width)).toBe(240)

      const block = previewBlock(orcaPage, preview, 'FIRST')
      const paragraph = block.locator(':scope > p')
      await expect.poll(async () => (await rectOf(paragraph)).width).toBeGreaterThanOrEqual(440)

      await block.hover()
      await block.getByRole('button', { name: 'Add note', exact: true }).click()
      const composer = block.locator('.markdown-annotation-composer')
      await expect(composer).toBeVisible()
      const paragraphRect = await rectOf(paragraph)
      expect((await rectOf(composer)).top).toBeGreaterThanOrEqual(paragraphRect.bottom - 1)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('R6 large virtualised preview keeps 840px rows that do not shift or overlap', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1920)
    const context = await getActiveWorktreeContext(orcaPage)
    // Why: the same over-1MB shape the large preview spec used, so the virtualised path renders.
    const content = `# Reading width\n\n${Array.from(
      { length: 2000 },
      (_, index) =>
        `## Section ${index}\n\n${'Readable content with **emphasis** and a reference. '.repeat(10)}\n\n`
    ).join('')}`
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'large',
        testInfo.workerIndex,
        content
      )
      const preview = await openPreview(orcaPage, context, filePath)
      await expect(preview.locator('[data-markdown-virtual-preview]')).toHaveCount(1)

      await preview.evaluate((element) => {
        element.scrollTop = element.scrollHeight / 2
      })
      // Pick a mounted paragraph block well inside the viewport, away from the mid-scroll edges.
      let blockKey: string | null = null
      await expect
        .poll(async () => {
          blockKey = await preview.evaluate((element) => {
            const viewport = element.getBoundingClientRect()
            const blocks = Array.from(
              element.querySelectorAll<HTMLElement>(
                '.markdown-annotation-block[data-annotation-block-key]'
              )
            )
            const target = blocks.find((block) => {
              const r = block.getBoundingClientRect()
              return (
                block.querySelector(':scope > p') !== null &&
                r.top > viewport.top + 200 &&
                r.bottom < viewport.bottom - 200
              )
            })
            return target?.dataset.annotationBlockKey ?? null
          })
          return blockKey
        })
        .not.toBeNull()
      const block = preview.locator(`[data-annotation-block-key="${blockKey}"]`)
      const paragraph = block.locator(':scope > p')
      await settledWidth(paragraph, COLUMN_PX)
      const topBefore = (await rectOf(block)).top

      await block.hover()
      await block.getByRole('button', { name: 'Add note', exact: true }).click()
      await expect(block.locator('.markdown-annotation-composer')).toBeVisible()
      await expectHolds(async () => {
        const drift = Math.abs((await rectOf(block)).top - topBefore)
        const overlap = await preview
          .locator('[data-preview-block-loaded]')
          .evaluateAll((nodes) =>
            nodes
              .slice(1)
              .some(
                (node, index) =>
                  node.getBoundingClientRect().top < nodes[index].getBoundingClientRect().bottom - 1
              )
          )
        return drift <= 2 && !overlap
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('R7 rich editor at 1200px keeps the column still while a draft and notes come and go', async ({
    orcaPage
  }, testInfo) => {
    await layoutWindow(orcaPage, 1200)
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null
    try {
      filePath = await createMarkdownFixture(
        context,
        FIXTURE_DIRECTORY,
        'rich-1200',
        testInfo.workerIndex,
        DOCUMENT
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)
      const first = editor.locator('p').filter({ hasText: 'FIRST' }).first()
      const second = editor.locator('p').filter({ hasText: 'SECOND' }).first()
      await settledWidth(second, COLUMN_PX)
      const column = await rectOf(second)

      await first.click({ clickCount: 3 })
      const addNote = orcaPage.getByRole('button', { name: 'Add review note', exact: true })
      await expect(addNote).toBeVisible()
      const button = await rectOf(addNote)
      // The add button sits in the gap right of the text, before the rail's cards start.
      expect(button.left).toBeGreaterThanOrEqual(column.right)
      expect(button.right).toBeLessThanOrEqual(column.right + 32)

      await addNote.click()
      const draft = orcaPage.locator('.orca-diff-comment-popover')
      await expect(draft).toBeVisible()
      expectSameRect(await rectOf(second), column)
      expect((await rectOf(draft)).left).toBeGreaterThanOrEqual(column.right)

      await orcaPage.getByPlaceholder('Add note for the AI').fill('Reading width note')
      await orcaPage.getByPlaceholder('Add note for the AI').press('Enter')
      const card = orcaPage.locator('.rich-markdown-review-note-card').first()
      await expect(card).toBeVisible()
      expectSameRect(await rectOf(second), column)

      await orcaPage.getByRole('button', { name: 'Hide review notes', exact: true }).click()
      await expect(card).toBeHidden()
      expectSameRect(await rectOf(second), column)
      await orcaPage.getByRole('button', { name: 'Show review notes', exact: true }).click()
      await expect(card).toBeVisible()
      expectSameRect(await rectOf(second), column)

      // With a note showing on narrower panes, a new selection's add button stays clear of the card.
      for (const width of [800, 1000]) {
        await layoutWindow(orcaPage, width)
        await expect(card).toBeVisible()
        // Why: select from the keyboard; a click on the noted text can select the whole note range.
        const line = await rectOf(first)
        await orcaPage.mouse.click(line.left + 40, line.top + 8)
        await orcaPage.keyboard.press('Home')
        for (let step = 0; step < 5; step += 1) {
          await orcaPage.keyboard.press('Shift+ArrowRight')
        }
        await expect(addNote).toBeVisible()
        const buttonRect = await rectOf(addNote)
        expect(buttonRect.right).toBeLessThanOrEqual((await rectOf(card)).left)
        await orcaPage.keyboard.press('ArrowRight')
        await expect(addNote).toBeHidden()
      }
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
