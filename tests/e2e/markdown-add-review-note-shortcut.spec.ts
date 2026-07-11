import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

test.describe('Markdown add-review-note shortcut', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opens the review-note composer for the current selection in the rich editor', async ({
    orcaPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note',
        testInfo.workerIndex,
        'A paragraph to annotate with a review note.\n'
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)
      await editor.click()
      await orcaPage.keyboard.press('ControlOrMeta+A')

      await orcaPage.keyboard.press('ControlOrMeta+Alt+N')

      await expect(orcaPage.getByPlaceholder('Add note for the AI')).toBeVisible({
        timeout: 5_000
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('does not open the composer without a text selection', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-no-selection',
        testInfo.workerIndex,
        'A paragraph without any selection.\n'
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)
      await editor.click()

      await orcaPage.keyboard.press('ControlOrMeta+Alt+N')

      await expect(orcaPage.getByPlaceholder('Add note for the AI')).toHaveCount(0)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
