import type { Locator, Page } from '@stablyai/playwright-test'
import type { Editor, JSONContent } from '@tiptap/core'
import type { MarkdownManager } from '@tiptap/markdown'
import { expect, test } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const PARAGRAPH_COUNT = Number(process.env.ORCA_MARKDOWN_REVIEW_PERF_PARAGRAPHS ?? '500')
const targetIndex = Math.floor(PARAGRAPH_COUNT / 2)
const paragraph = (index: number) =>
  `Paragraph ${index}. Ordinary editing and selection of plain prose.`
const SOURCE = Array.from({ length: PARAGRAPH_COUNT }, (_, index) => paragraph(index)).join('\n\n')

type ReviewSelectionMetrics = {
  calls: number
  jsonCalls: number
  serializeMs: number
  jsonMs: number
  frameGaps: number[]
}

type ReviewSelectionProbe = {
  snapshot: () => ReviewSelectionMetrics
  reset: () => void
  restore: () => void
}

type PageRichMarkdownReviewEditorElement = HTMLElement & {
  editor?: Editor & { markdown?: MarkdownManager }
  __reviewSelectionProbe?: ReviewSelectionProbe
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function measure(editor: Locator, reset = false): Promise<ReviewSelectionMetrics> {
  return editor.evaluate((element, reset) => {
    const editorElement =
      element.closest<PageRichMarkdownReviewEditorElement>('.rich-markdown-editor')
    const probe = editorElement?.__reviewSelectionProbe
    if (!probe) {
      throw new Error('Review selection probe missing')
    }
    if (reset) {
      probe.reset()
    }
    return probe.snapshot()
  }, reset)
}

test('selection and scrolling reuse Markdown review source lines', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  expect(Buffer.byteLength(SOURCE)).toBeLessThan(600 * 1024)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-review-perf',
    'review-selection',
    testInfo.workerIndex,
    SOURCE
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor.locator('p')).toHaveCount(PARAGRAPH_COUNT, { timeout: 60_000 })
  await editor.evaluate((element) => {
    const editorElement =
      element.closest<PageRichMarkdownReviewEditorElement>('.rich-markdown-editor')
    const instance = editorElement?.editor
    if (!editorElement || !instance) {
      throw new Error('Editor unavailable')
    }
    const markdown = instance.markdown
    if (!markdown) {
      throw new Error('Markdown manager missing')
    }
    const serialize = markdown.serialize
    const getJSON = instance.getJSON
    let calls = 0
    let jsonCalls = 0
    let serializeMs = 0
    let jsonMs = 0
    let frameGaps: number[] = []
    let previousFrame: number | null = null
    let frameId = 0
    const tick = (now: number) => {
      if (previousFrame !== null) {
        frameGaps.push(now - previousFrame)
      }
      previousFrame = now
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    markdown.serialize = (content: JSONContent): string => {
      const start = performance.now()
      try {
        calls++
        return serialize.call(markdown, content)
      } finally {
        serializeMs += performance.now() - start
      }
    }
    instance.getJSON = (): ReturnType<Editor['getJSON']> => {
      const start = performance.now()
      try {
        jsonCalls++
        return getJSON.call(instance)
      } finally {
        jsonMs += performance.now() - start
      }
    }
    editorElement.__reviewSelectionProbe = {
      snapshot: () => ({ calls, jsonCalls, serializeMs, jsonMs, frameGaps }),
      reset: () => {
        calls = 0
        jsonCalls = 0
        serializeMs = 0
        jsonMs = 0
        frameGaps = []
        previousFrame = null
      },
      restore: () => {
        cancelAnimationFrame(frameId)
        markdown.serialize = serialize
        instance.getJSON = getJSON
      }
    }
  })
  try {
    const target = editor.getByText(paragraph(targetIndex), { exact: true })
    await target.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    const point = await target.evaluate((element) => {
      const text = element.firstChild
      if (!(text instanceof Text)) {
        throw new Error('Paragraph text missing')
      }
      const range = document.createRange()
      range.setStart(text, 0)
      range.collapse(true)
      const rect = range.getBoundingClientRect()
      return { x: rect.left, y: rect.top + rect.height / 2 }
    })
    await orcaPage.mouse.click(point.x, point.y)
    await orcaPage.keyboard.press('Shift+ArrowRight')
    await expect(
      orcaPage.getByRole('button', { name: 'Add review note', exact: true })
    ).toBeVisible()
    await frames(orcaPage)
    const cold = await measure(editor)
    await measure(editor, true)
    for (let index = 0; index < 20; index++) {
      await orcaPage.keyboard.press('Shift+ArrowRight')
      await frames(orcaPage)
    }
    const selection = await measure(editor)
    expect(await orcaPage.evaluate(() => window.getSelection()?.toString())).toBe(
      paragraph(targetIndex).slice(0, 21)
    )
    const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
    await measure(editor, true)
    for (let index = 0; index < 10; index++) {
      await viewport.evaluate((element, index) => {
        element.scrollTop += index % 2 ? -8 : 8
      }, index)
      await frames(orcaPage)
    }
    const scroll = await measure(editor)
    const result = {
      paragraphs: PARAGRAPH_COUNT,
      sourceBytes: Buffer.byteLength(SOURCE),
      cold,
      selection,
      scroll
    }
    await testInfo.attach('review-selection-metrics', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json'
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    await expect(editor).toBeFocused()
    const tab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'review-selection' }).last()
    await expect(tab.locator('span.rounded-full')).toHaveCount(0)
    await orcaPage.screenshot({ path: testInfo.outputPath('review-selection.png') })
    expect(selection.calls).toBe(0)
    expect(selection.jsonCalls).toBe(0)
    expect(scroll.calls).toBe(0)
    expect(scroll.jsonCalls).toBe(0)
  } finally {
    await editor.evaluate((element) => {
      const editorElement =
        element.closest<PageRichMarkdownReviewEditorElement>('.rich-markdown-editor')
      editorElement?.__reviewSelectionProbe?.restore()
    })
  }
})
