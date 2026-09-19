import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const LABEL = '[label](path) $5'

test('literal link labels survive editing and reopening', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const file = await createMarkdownFixture(
    context,
    'markdown-links',
    'literal-label',
    testInfo.workerIndex,
    '# Link label safety\n\n[Original label](https://example.com)\n\nUnchanged tail.\n'
  )
  try {
    await openMarkdownFixture(orcaPage, context, file)
    const editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor.locator('a')).toHaveText('Original label')
    await testInfo.attach('before-edit', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('before-edit.png') }),
      contentType: 'image/png'
    })
    await editor.locator('a').evaluate((link) => {
      link.closest<HTMLElement>('[contenteditable]')?.focus()
      const range = document.createRange()
      range.selectNodeContents(link)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString()))
      .toBe('Original label')
    await orcaPage.keyboard.insertText(LABEL)
    await expect(editor.locator('a')).toHaveText(LABEL)
    await orcaPage.keyboard.press('ControlOrMeta+S')
    await expect.poll(() => readFileSync(file, 'utf8')).not.toContain('Original label')
    expect(readFileSync(file, 'utf8')).toContain('https://example.com')
    await closeActiveEditorTab(orcaPage, file)
    await openMarkdownFixture(orcaPage, context, file)
    const reopened = await waitForRichMarkdownEditor(orcaPage)
    await expect(reopened.locator('a')).toHaveCount(1)
    await expect(reopened.locator('a')).toHaveText(LABEL)
    await expect(reopened.locator('a')).toHaveAttribute('href', 'https://example.com')
    await expect(reopened.locator('p').last()).toHaveText('Unchanged tail.')
    await testInfo.attach('after-reopen', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('after-reopen.png') }),
      contentType: 'image/png'
    })
  } finally {
    await cleanupMarkdownFixture(file)
  }
})
