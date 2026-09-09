import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

const WIDE_LINE =
  'const veryLongLineOfCodeThatShouldNotWrapAtAllUnderAnyCircumstances = ' + `"${'a'.repeat(160)}"`
const WIDE_CODE_BLOCK_MARKDOWN = `# Wide code block\n\n\`\`\`ts\n${WIDE_LINE}\n\`\`\`\n`

test.describe('Wide code blocks scroll horizontally', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('a code block wider than the editor scrolls instead of wrapping', async ({
    orcaPage
  }, testInfo) => {
    let filePath: string | null = null

    try {
      const context = await getActiveWorktreeContext(orcaPage)
      filePath = await createMarkdownFixture(
        context,
        'code-block-horizontal-scroll',
        testInfo.workerIndex,
        WIDE_CODE_BLOCK_MARKDOWN
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)

      const metrics = await orcaPage.evaluate(() => {
        const pre = document.querySelector('.rich-markdown-editor pre')
        if (!pre) {
          throw new Error('Code block was not rendered')
        }
        return {
          whiteSpace: window.getComputedStyle(pre).whiteSpace,
          scrollWidth: pre.scrollWidth,
          clientWidth: pre.clientWidth
        }
      })

      // The wide viewport keeps the editor pane wider than WIDE_LINE's
      // unbroken run needs to fit on one line, so pre-wrap wraps it at
      // ordinary word boundaries with no overflow — scrollWidth only
      // exceeds clientWidth once white-space: pre removes those wrap
      // points, which is what pins this assertion to the fix. A narrower
      // pane lets the browser's overflow-wrap: break-word fallback wrap
      // the run mid-word even under pre-wrap, which would pass either way.
      expect(metrics.whiteSpace).toBe('pre')
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
