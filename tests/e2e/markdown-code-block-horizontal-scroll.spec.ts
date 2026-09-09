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
    await orcaPage.setViewportSize({ width: 900, height: 700 })
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

      expect(metrics.whiteSpace).toBe('pre')
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
