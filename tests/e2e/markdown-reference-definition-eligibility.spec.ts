import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, switchToWorktree } from './helpers/store'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const PROSE =
  '[Bug]: Backspace at the start of the first line under a heading merges that line into the heading'
const MESSAGE = 'Editable only in code mode because this file contains reference-style links.'

for (const workspace of ['git', 'folder'] as const) {
  test(`allows label prose while keeping actual definitions in Source in ${workspace}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-reference-prose-')))
      registerPostElectronShutdownCleanup(async () =>
        rmSync(folder, { recursive: true, force: true })
      )
      await orcaPage.evaluate(async (folderPath) => {
        if (!(await window.__store!.getState().addNonGitFolder(folderPath))) {
          throw new Error('Could not add the owned folder fixture')
        }
      }, folder)
      await expect
        .poll(async () => (await getActiveWorktreeContext(orcaPage)).rootPath)
        .toBe(folder)
    }
    const context = await getActiveWorktreeContext(orcaPage)
    const proseSource = `${PROSE}\n\nOrdinary paragraph.\n`
    const prosePath = await createMarkdownFixture(
      context,
      'reference-prose',
      workspace,
      0,
      proseSource
    )
    const definitionSource = '[id]: https://example.com\n\n[Actual reference][id]\n'
    const definitionPath = await createMarkdownFixture(
      context,
      'reference-link',
      workspace,
      0,
      definitionSource
    )
    try {
      await openMarkdownFixture(orcaPage, context, prosePath)
      await expect(
        orcaPage
          .locator('.rich-markdown-editor, .view-lines[role="presentation"]')
          .filter({ hasText: PROSE })
          .first()
      ).toBeVisible()
      const directory = process.env.ORCA_REFERENCE_DEFINITION_PROOF_DIR
      if (directory) {
        mkdirSync(directory, { recursive: true })
        await orcaPage.screenshot({ path: path.join(directory, `${workspace}.png`) })
      }
      await expect(orcaPage.getByText(MESSAGE, { exact: true })).not.toBeVisible()
      const rich = await waitForRichMarkdownEditor(orcaPage)
      await expect(rich).toContainText(PROSE)
      expect(readFileSync(prosePath, 'utf8')).toBe(proseSource)
      await rich.locator('p').last().click()
      await orcaPage.keyboard.press('End')
      await orcaPage.keyboard.insertText(' Saved edit.')
      await orcaPage.keyboard.press('ControlOrMeta+S')
      await expect
        .poll(() => readFileSync(prosePath, 'utf8'), { timeout: 15_000 })
        .toContain('Ordinary paragraph. Saved edit.')
      const savedProse = readFileSync(prosePath, 'utf8')
      expect(savedProse).toContain(PROSE)
      await closeActiveEditorTab(orcaPage, prosePath)
      if (workspace === 'folder') {
        await switchToWorktree(orcaPage, context.worktreeId)
      }
      await openMarkdownFixture(orcaPage, context, prosePath)
      await expect(await waitForRichMarkdownEditor(orcaPage)).toContainText('Saved edit.')
      expect(readFileSync(prosePath, 'utf8')).toBe(savedProse)
      await closeActiveEditorTab(orcaPage, prosePath)
      if (workspace === 'folder') {
        await switchToWorktree(orcaPage, context.worktreeId)
      }
      await openMarkdownFixture(orcaPage, context, definitionPath)
      await expect(orcaPage.getByText(MESSAGE, { exact: true })).toBeVisible()
      await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible()
      await expect(orcaPage.locator('.rich-markdown-editor')).not.toBeVisible()
      expect(readFileSync(definitionPath, 'utf8')).toBe(definitionSource)
    } finally {
      await cleanupMarkdownFixture(prosePath)
      await cleanupMarkdownFixture(definitionPath)
    }
  })
}
