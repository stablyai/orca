import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'

for (const workspace of ['git', 'folder'] as const) {
  test(`keeps ordered-list first-block code editable in Source in ${workspace}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-ordered-code-folder-')))
      registerPostElectronShutdownCleanup(async () =>
        rmSync(folder, { recursive: true, force: true })
      )
      await orcaPage.evaluate(async (folderPath) => {
        if (!(await window.__store!.getState().addNonGitFolder(folderPath))) {
          throw new Error('Could not register owned folder')
        }
      }, folder)
      await expect
        .poll(async () => (await getActiveWorktreeContext(orcaPage)).rootPath)
        .toBe(folder)
    }
    const context = await getActiveWorktreeContext(orcaPage)
    for (const [label, firstMarker, secondMarker, fence, language, code] of [
      ['decimal', '1.', '2.', '```', 'js', 'const answer = 42\nconsole.log(answer)'],
      ['mermaid', '1.', '2.', '~~~', 'mermaid', 'graph TD\nA[Line1<br/>Line2] --> B'],
      ['alphabetic', 'a.', 'b.', '```', 'js', 'const answer = 42\nconsole.log(answer)'],
      ['roman', 'I.', 'II.', '~~~', 'js', 'const answer = 42\nconsole.log(answer)']
    ] as const) {
      const indent = ' '.repeat(firstMarker.length + 1)
      const source = `${firstMarker} ${fence}${language}\n${indent}${code.replaceAll('\n', `\n${indent}`)}\n${indent}${fence}\n${secondMarker} Second item\n\nTail.\n`
      const file = await createMarkdownFixture(
        context,
        'ordered-code-proof',
        `${workspace}-${label}`,
        testInfo.workerIndex,
        source
      )
      try {
        await orcaPage.evaluate(
          (id) => window.__store!.getState().setActiveWorktree(id),
          context.worktreeId
        )
        await openMarkdownFixture(orcaPage, context, file)
        const monaco = orcaPage.locator('.monaco-editor').first()
        const notice = orcaPage.getByText(
          'Editable only in code mode because this file contains unsupported Markdown syntax.',
          { exact: true }
        )
        await expect(monaco).toBeVisible({ timeout: 25_000 })
        await expect(notice).toBeVisible()
        await expect(orcaPage.locator('.rich-markdown-editor')).toHaveCount(0)
        await expect(
          orcaPage.getByRole('button', { name: 'Open anyway', exact: true })
        ).toHaveCount(0)
        await expect(
          monaco.locator('.view-line').filter({ hasText: code.split('\n')[0] })
        ).toHaveCount(1)
        await monaco.click()
        await orcaPage.keyboard.press('ControlOrMeta+End')
        await orcaPage.keyboard.insertText('Edited after.')
        await orcaPage.keyboard.press('ControlOrMeta+S')
        await expect.poll(() => readFileSync(file, 'utf8')).toBe(`${source}Edited after.`)
        const saved = readFileSync(file, 'utf8')
        writeFileSync(testInfo.outputPath(`${label}-saved-source.md`), saved)
        await testInfo.attach(`${label}-saved-source`, {
          body: saved,
          contentType: 'text/markdown'
        })
        await closeActiveEditorTab(orcaPage, file)
        await orcaPage.evaluate(
          (id) => window.__store!.getState().setActiveWorktree(id),
          context.worktreeId
        )
        await openMarkdownFixture(orcaPage, context, file)
        await expect(monaco).toBeVisible()
        await expect(notice).toBeVisible()
        await expect(monaco.locator('.view-line').filter({ hasText: 'Edited after.' })).toHaveCount(
          1
        )
        await expect(
          monaco.locator('.view-line').filter({ hasText: code.split('\n')[1] })
        ).toHaveCount(1)
        await testInfo.attach(`${label}-reopened-source`, {
          body: await orcaPage.screenshot({
            path: testInfo.outputPath(`${label}-reopened-source.png`)
          }),
          contentType: 'image/png'
        })
        await closeActiveEditorTab(orcaPage, file)
      } finally {
        await cleanupMarkdownFixture(file)
      }
    }
  })
}
