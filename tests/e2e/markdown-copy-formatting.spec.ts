import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

test('copying a rich selection preserves Markdown formatting', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    'markdown-clipboard',
    'formatted-copy',
    testInfo.workerIndex,
    '# Copy formatting\n\nA **bold** paragraph with a [link](https://example.com).\n'
  )
  try {
    await openMarkdownFixture(orcaPage, context, filePath)
    const editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor.locator('strong')).toHaveText('bold')
    await editor.locator('p').selectText()
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString()))
      .toBe('A bold paragraph with a link.')
    await testInfo.attach('formatted-selection', {
      body: await orcaPage.screenshot({ path: testInfo.outputPath('formatted-selection.png') }),
      contentType: 'image/png'
    })
    const copied = await editor.evaluate((element) => {
      // Keep this check isolated from the user's system clipboard.
      const clipboardData = new DataTransfer()
      element.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
      )
      return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') }
    })
    expect(copied.text).toContain('**bold**')
    expect(copied.text).toContain('[link](https://example.com)')
    expect(copied.text).not.toContain('# Copy formatting')
    expect(copied.html).toContain('<strong>bold</strong>')
    await expect(editor.locator('p')).toHaveText('A bold paragraph with a link.')
    await testInfo.attach('copied-markdown', { body: copied.text, contentType: 'text/markdown' })

    await editor.selectText()
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString()))
      .toContain('Copy formatting')
    const copiedBlocks = await editor.evaluate((element) => {
      const clipboardData = new DataTransfer()
      element.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
      )
      return clipboardData.getData('text/plain')
    })
    expect(copiedBlocks).toBe(
      '# Copy formatting\n\nA **bold** paragraph with a [link](https://example.com).'
    )
    await testInfo.attach('copied-blocks', { body: copiedBlocks, contentType: 'text/markdown' })
  } finally {
    await cleanupMarkdownFixture(filePath)
  }
})
