import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext
} from './helpers/markdown-ordered-list-exit'

const MERMAID_MARKDOWN = [
  '# Mermaid preview',
  '',
  '```mermaid',
  'flowchart LR',
  '  Draft[Draft] --> Review[Review]',
  '  Review --> Ship[Ship]',
  '```',
  ''
].join('\n')

test.describe('Markdown Mermaid full-size preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opens a full-size Mermaid dialog from markdown preview', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'mermaid-full-size',
        testInfo.workerIndex,
        MERMAID_MARKDOWN
      )
      const relativePath = path.relative(context.rootPath, filePath)

      await orcaPage.evaluate(
        ({ filePath, relativePath, worktreeId }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }

          store.getState().openMarkdownPreview({
            filePath,
            relativePath,
            worktreeId,
            language: 'markdown'
          })
        },
        { filePath, relativePath, worktreeId: context.worktreeId }
      )

      await expect(orcaPage.locator('.markdown-preview')).toBeVisible()

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => document.querySelectorAll('.mermaid-preview-wrapper').length),
          { timeout: 15_000, message: 'Expected markdown preview to render one Mermaid block' }
        )
        .toBe(1)

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(
              () => document.querySelectorAll('.mermaid-preview-wrapper .mermaid-block svg').length
            ),
          { timeout: 15_000, message: 'Expected inline Mermaid preview SVG to render' }
        )
        .toBe(1)

      const previewWrapper = orcaPage.locator('.mermaid-preview-wrapper')
      const previewBox = await previewWrapper.boundingBox()
      expect(previewBox).not.toBeNull()
      if (!previewBox) {
        throw new Error('Expected Mermaid preview wrapper bounds before click target check')
      }

      await orcaPage.mouse.click(previewBox.x + previewBox.width - 6, previewBox.y + 6)
      await expect(orcaPage.getByRole('dialog', { name: 'Open full size' })).toHaveCount(0)

      const openButton = orcaPage.getByRole('button', { name: 'Open full size' })
      await expect(openButton).toBeVisible()
      await openButton.click()

      const dialog = orcaPage.getByRole('dialog', { name: 'Open full size' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Press Esc to close')

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => document.querySelectorAll('.mermaid-block svg').length),
          { timeout: 15_000, message: 'Expected inline and dialog Mermaid SVG renders' }
        )
        .toBeGreaterThanOrEqual(2)

      await orcaPage.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
