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

      await orcaPage.keyboard.press('ControlOrMeta+Shift+A')

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
        // Set source mode through the production store action; the tested shortcut is independent of the toolbar menu.
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

      await orcaPage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(orcaPage.getByPlaceholder('Add note for the AI')).toBeVisible({
        timeout: 5_000
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('opens the inline composer for the selected block in the markdown preview', async ({
    orcaPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-preview',
        testInfo.workerIndex,
        'A paragraph to annotate from the preview.\n'
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)
      await orcaPage.evaluate(() => {
        // Open the separate markdown-preview file mode through its production action.
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        const file = state.openFiles.find((f) => f.id === state.activeFileId)
        if (!file) {
          throw new Error('No active editor file')
        }
        state.openMarkdownPreview(
          {
            filePath: file.filePath,
            relativePath: file.relativePath,
            worktreeId: file.worktreeId,
            runtimeEnvironmentId: file.runtimeEnvironmentId,
            language: 'markdown'
          },
          { sourceFileId: file.id }
        )
      })
      await expect(orcaPage.locator('[data-annotation-block-key]').first()).toBeVisible({
        timeout: 25_000
      })

      await orcaPage.evaluate(() => {
        // Model reader selection in the focusable preview root and its rendered block.
        const block = document.querySelector<HTMLElement>('[data-annotation-block-key]')
        if (!block) {
          throw new Error('No annotation block found in preview')
        }
        const focusable = block.closest<HTMLElement>('[tabindex]')
        if (!focusable) {
          throw new Error('No focusable preview root above the annotation block')
        }
        focusable.focus()
        const paragraph = block.querySelector('p') ?? block
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        selection?.removeAllRanges()
        selection?.addRange(range)
      })

      await orcaPage.keyboard.press('ControlOrMeta+Shift+A')

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

      await orcaPage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(orcaPage.getByPlaceholder('Add note for the AI')).toHaveCount(0)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
