import { test, expect } from './helpers/mcode-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

test.describe('Markdown add-review-note shortcut', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
  })

  test('opens the review-note composer for the current selection in the rich editor', async ({
    mcodePage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(mcodePage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note',
        testInfo.workerIndex,
        'A paragraph to annotate with a review note.\n'
      )
      await openMarkdownFixture(mcodePage, context, filePath)
      const editor = await waitForRichMarkdownEditor(mcodePage)
      await editor.click()
      await mcodePage.keyboard.press('ControlOrMeta+A')

      await mcodePage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(mcodePage.getByPlaceholder('Add note for the AI')).toBeVisible({
        timeout: 5_000
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('opens the composer for the current selection in the Monaco source editor', async ({
    mcodePage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(mcodePage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-source',
        testInfo.workerIndex,
        'A paragraph to annotate from the source editor.\n'
      )
      await openMarkdownFixture(mcodePage, context, filePath)
      await waitForRichMarkdownEditor(mcodePage)
      await mcodePage.evaluate(() => {
        // Why: switch to source mode through the store — the toolbar toggle is
        // an icon menu that is brittle to locate; the store action is what it
        // dispatches anyway, and the shortcut under test is mode-independent.
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
      const monaco = mcodePage.locator('.monaco-editor').first()
      await expect(monaco).toBeVisible({ timeout: 25_000 })
      await monaco.click()
      await mcodePage.keyboard.press('ControlOrMeta+A')

      await mcodePage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(mcodePage.getByPlaceholder('Add note for the AI')).toBeVisible({
        timeout: 5_000
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('opens the inline composer for the selected block in the markdown preview', async ({
    mcodePage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(mcodePage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-preview',
        testInfo.workerIndex,
        'A paragraph to annotate from the preview.\n'
      )
      await openMarkdownFixture(mcodePage, context, filePath)
      await waitForRichMarkdownEditor(mcodePage)
      await mcodePage.evaluate(() => {
        // Why: open the real markdown-preview tab through the store — preview
        // is a separate file mode, not a view mode of the edit tab, and the
        // toolbar entry point is an icon menu that is brittle to locate.
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
      await expect(mcodePage.locator('[data-annotation-block-key]').first()).toBeVisible({
        timeout: 25_000
      })

      await mcodePage.evaluate(() => {
        // Why: mirror a reader selecting rendered text — focus lands on the
        // preview's tabIndex=0 root and the DOM selection covers the block.
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

      await mcodePage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(mcodePage.getByPlaceholder('Add note for the AI')).toBeVisible({
        timeout: 5_000
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('does not open the composer without a text selection', async ({ mcodePage }, testInfo) => {
    const context = await getActiveWorktreeContext(mcodePage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'add-review-note-no-selection',
        testInfo.workerIndex,
        'A paragraph without any selection.\n'
      )
      await openMarkdownFixture(mcodePage, context, filePath)
      const editor = await waitForRichMarkdownEditor(mcodePage)
      await editor.click()

      await mcodePage.keyboard.press('ControlOrMeta+Shift+A')

      await expect(mcodePage.getByPlaceholder('Add note for the AI')).toHaveCount(0)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
