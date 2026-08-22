import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

const SELECTED_TEXT = 'Selection persists across tab switches.'

test.describe('Rich Markdown selection restoration', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('restores a native text selection after an A to B to A tab switch', async ({
    orcaPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let fileA: string | null = null
    let fileB: string | null = null

    try {
      fileA = await createMarkdownFixture(
        context,
        'selection-restore-a',
        testInfo.workerIndex,
        `${SELECTED_TEXT}\n\n## Proof context\n\nThe highlighted sentence must remain selected.\n`
      )
      fileB = await createMarkdownFixture(
        context,
        'selection-restore-b',
        testInfo.workerIndex,
        '# Intermediate tab\n\nSwitching here unmounts the first rich Markdown editor.\n'
      )
      await openMarkdownFixture(orcaPage, context, fileA)
      await openMarkdownFixture(orcaPage, context, fileB)

      const tabA = orcaPage
        .locator('[data-tab-id]')
        .filter({ hasText: path.basename(fileA) })
        .last()
      const tabB = orcaPage
        .locator('[data-tab-id]')
        .filter({ hasText: path.basename(fileB) })
        .last()
      await expect(tabA).toBeVisible()
      await expect(tabB).toBeVisible()

      await tabA.click()
      const editor = await waitForRichMarkdownEditor(orcaPage)
      await expect(editor).toContainText(SELECTED_TEXT, { timeout: 25_000 })
      await editor.click()
      await orcaPage.keyboard.press('ControlOrMeta+Home')
      await orcaPage.keyboard.press('Shift+End')
      await expect
        .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
        .toBe(SELECTED_TEXT)

      await tabB.click()
      await expect(editor).toContainText('Intermediate tab', { timeout: 25_000 })
      await tabA.click()
      await expect(editor).toContainText(SELECTED_TEXT, { timeout: 25_000 })
      await expect
        .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
        .toBe(SELECTED_TEXT)
    } finally {
      await cleanupMarkdownFixture(fileA)
      await cleanupMarkdownFixture(fileB)
    }
  })
})
