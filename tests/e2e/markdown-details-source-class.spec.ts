import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

for (const kind of ['git', 'folder'] as const) {
  test(`details save keeps source classes in a ${kind} workspace`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    let context = await getActiveWorktreeContext(orcaPage)
    if (kind === 'folder') {
      const folderPath = mkdtempSync(path.join(os.tmpdir(), 'orca-details-class-'))
      registerPostElectronShutdownCleanup(async () =>
        rmSync(folderPath, { recursive: true, force: true })
      )
      const worktreeId = await orcaPage.evaluate(async (folderPath) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing fixture store')
        }
        const group = await window.api.projectGroups.create({
          name: 'Details fixture',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups()
        const folder = await state.createFolderWorkspace({
          projectGroupId: group.id,
          name: 'Details document',
          folderPath
        })
        if (!folder) {
          throw new Error('Missing fixture folder')
        }
        const worktreeId = `folder:${folder.id}`
        state.setActiveWorktree(worktreeId)
        return worktreeId
      }, folderPath)
      context = { worktreeId, rootPath: folderPath }
    }
    const openFixture = async (filePath: string): Promise<void> => {
      await orcaPage.evaluate(
        (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
        context.worktreeId
      )
      await openMarkdownFixture(orcaPage, context, filePath)
    }
    const freshPath = await createMarkdownFixture(
      context,
      '.orca-e2e-details-class',
      'fresh',
      testInfo.workerIndex,
      'Before.\n'
    )
    await openFixture(freshPath)
    let editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor).toBeFocused()
    await editor.locator('p').evaluate((paragraph) => {
      const text = paragraph.firstChild
      if (!(text instanceof Text)) {
        throw new Error('Missing paragraph text')
      }
      const range = document.createRange()
      range.setStart(text, text.length)
      range.collapse(true)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.type('/toggle-text')
    await orcaPage.getByRole('option', { name: 'Toggle Text', exact: true }).click()
    await orcaPage.keyboard.type('Fresh')
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.type('Fresh body')
    const freshToggle = editor.locator('[data-type="details"]')
    await expect(freshToggle).toHaveClass(/orca-details/)
    await expect(freshToggle.locator('summary')).toHaveText('Fresh')
    await expect(freshToggle.locator('[data-type="detailsContent"]')).toHaveText('Fresh body')
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const save = `${isMac ? 'Meta' : 'Control'}+s`
    await orcaPage.keyboard.press(save)
    await expect.poll(() => readFileSync(freshPath, 'utf8')).toContain('Fresh body')
    writeFileSync(testInfo.outputPath('fresh-details.md'), readFileSync(freshPath))
    await testInfo.attach('fresh-details.md', {
      body: readFileSync(freshPath),
      contentType: 'text/markdown'
    })
    await orcaPage.screenshot({ path: testInfo.outputPath(`fresh-details-${kind}.png`) })
    expect(readFileSync(freshPath, 'utf8')).toContain('<details open>')
    expect(readFileSync(freshPath, 'utf8')).not.toContain('orca-details')
    await closeActiveEditorTab(orcaPage, freshPath)
    await openFixture(freshPath)
    editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor.locator('[data-type="details"] summary')).toHaveText('Fresh')

    for (const legacy of [false, true]) {
      const opening = legacy ? '<details class="orca-details" open>' : '<details open>'
      const filePath = await createMarkdownFixture(
        context,
        '.orca-e2e-details-class',
        legacy ? 'legacy' : 'plain',
        testInfo.workerIndex,
        `${opening}\n<summary>Toggle</summary>\n\nBody\n\n</details>\n`
      )
      await openFixture(filePath)
      editor = await waitForRichMarkdownEditor(orcaPage)
      const body = editor.locator('[data-type="detailsContent"] p')
      await expect(body).toHaveText('Body')
      await body.click()
      await body.evaluate((paragraph) => {
        const text = paragraph.firstChild
        if (!(text instanceof Text)) {
          throw new Error('Missing details body text')
        }
        const range = document.createRange()
        range.setStart(text, text.length)
        range.collapse(true)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await orcaPage.keyboard.type(' edited')
      await expect(body).toHaveText('Body edited')
      await orcaPage.keyboard.press(save)
      await expect.poll(() => readFileSync(filePath, 'utf8')).toContain('Body edited')
      expect(readFileSync(filePath, 'utf8')).toContain(opening)
      expect(readFileSync(filePath, 'utf8').includes('orca-details')).toBe(legacy)
      await closeActiveEditorTab(orcaPage, filePath)
      await openFixture(filePath)
      editor = await waitForRichMarkdownEditor(orcaPage)
      await expect(editor.locator('[data-type="detailsContent"] p')).toHaveText('Body edited')
      writeFileSync(
        testInfo.outputPath(legacy ? 'legacy-details.md' : 'plain-details.md'),
        readFileSync(filePath)
      )
      await testInfo.attach(legacy ? 'legacy-details.md' : 'plain-details.md', {
        body: readFileSync(filePath),
        contentType: 'text/markdown'
      })
    }
  })
}
