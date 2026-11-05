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

const ARTICLE = [
  '---',
  'title: Turing-Test',
  'draft: true',
  '---',
  '',
  '# Der Turing-Test',
  '',
  'First paragraph with user_name_field and feature~2.',
  '',
  '> [!wissenswert] Das Original war ein Ratespiel',
  '> In Turings Aufsatz heißt der Test "Imitation Game".',
  '',
  'Second paragraph with a literal * and an unmatched `.',
  '',
  '> [!zeitstrahl] 75 Jahre Imitation Game',
  '> - 1950 · Alan Turing veröffentlicht seinen Aufsatz.',
  '> - 1980 · John Searle widerspricht.',
  '',
  'Third paragraph to edit.',
  '',
  '> [!NOTE]',
  '> Keep this callout unchanged.',
  '',
  '> [!selbsttest]',
  '> - Was bedeutet Intelligenz?',
  ''
].join('\n')

for (const large of [false, true]) {
  test(`keeps callout source byte-for-byte across edits, save and reopen (${large ? 'large' : 'article'})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const context = await getActiveWorktreeContext(orcaPage)
    const source = ARTICLE + (large ? `\n${'Unchanged user_name prose. '.repeat(2_100)}\n` : '')
    const filePath = await createMarkdownFixture(
      context,
      'callout-fidelity',
      'article',
      testInfo.workerIndex,
      source
    )
    try {
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)
      await expect(editor).toContainText('[!wissenswert]')
      let expected = source
      for (const prefix of ['First paragraph', 'Second paragraph', 'Third paragraph']) {
        const paragraph = editor.locator('p').filter({ hasText: prefix }).first()
        await paragraph.click()
        await paragraph.evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          range.collapse(true)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
        })
        await orcaPage.keyboard.insertText('Edited ')
        expected = expected.replace(prefix, `Edited ${prefix}`)
        await orcaPage.keyboard.press('ControlOrMeta+S')
        await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(expected)
      }
      await testInfo.attach('saved-source', { body: expected, contentType: 'text/markdown' })
      await closeActiveEditorTab(orcaPage, filePath)
      await openMarkdownFixture(orcaPage, context, filePath)
      const reopened = await waitForRichMarkdownEditor(orcaPage)
      await expect(reopened).toContainText('Edited First paragraph')
      await expect(reopened).toContainText('Edited Third paragraph')
      await expect(reopened.locator('blockquote')).toHaveCount(4)
      await expect(reopened).toContainText('[!zeitstrahl]')
      await testInfo.attach('reopened-article', {
        body: await orcaPage.screenshot({ path: testInfo.outputPath('reopened-article.png') }),
        contentType: 'image/png'
      })
      expect(readFileSync(filePath, 'utf8')).toBe(expected)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
}
