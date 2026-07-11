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

  test('opens the composer for the current selection in the Monaco source editor', async ({
    orcaPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-source',
        testInfo.workerIndex,
        'A paragraph to annotate from the source editor.\n'
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)
      await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        if (!state.activeFileId) {
          throw new Error('No active editor file')
        }
        state.setMarkdownViewMode(state.activeFileId, 'source')
      })
      const monaco = orcaPage.locator('.monaco-editor').first()
      await expect(monaco).toBeVisible({ timeout: 25_000 })
      await monaco.click()
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
