import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { switchToWorktree, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture
} from './helpers/markdown-editor-fixture'

const SOURCE = '\ufeff[^id]: note\n\nUses [^id].\n'
const MESSAGE = 'Editable only in code mode because this file contains footnotes.'

for (const workspace of ['git', 'folder'] as const) {
  test(`keeps footnote definitions in Source through Save and reopen in ${workspace}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-footnote-source-')))
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
    const filePath = await createMarkdownFixture(
      context,
      'footnote-source',
      workspace,
      testInfo.workerIndex,
      SOURCE
    )
    try {
      await openMarkdownFixture(orcaPage, context, filePath)
      await expect(
        orcaPage
          .locator('.rich-markdown-editor, .view-lines[role="presentation"]')
          .filter({ hasText: 'Uses' })
          .first()
      ).toBeVisible()
      const directory = process.env.ORCA_FOOTNOTE_PROOF_DIR
      if (directory) {
        mkdirSync(directory, { recursive: true })
        await orcaPage.screenshot({ path: path.join(directory, `${workspace}.png`) })
      }
      await expect(orcaPage.getByText(MESSAGE, { exact: true })).toBeVisible()
      await expect(orcaPage.locator('.rich-markdown-editor')).not.toBeVisible()
      expect(readFileSync(filePath, 'utf8')).toBe(SOURCE)
      await orcaPage.locator('.view-lines[role="presentation"]').first().click()
      await orcaPage.keyboard.press('ControlOrMeta+End')
      await orcaPage.keyboard.press('Enter')
      await orcaPage.keyboard.insertText('Saved control.')
      await orcaPage.keyboard.press('ControlOrMeta+S')
      await expect
        .poll(() => readFileSync(filePath, 'utf8'), { timeout: 15_000 })
        .toContain('Saved control.')
      const saved = readFileSync(filePath, 'utf8')
      expect(saved).toContain('[^id]: note')
      expect(saved).toContain('Uses [^id].')
      await closeActiveEditorTab(orcaPage, filePath)
      if (workspace === 'folder') {
        await switchToWorktree(orcaPage, context.worktreeId)
      }
      await openMarkdownFixture(orcaPage, context, filePath)
      await expect(orcaPage.getByText(MESSAGE, { exact: true })).toBeVisible()
      await expect(orcaPage.locator('.rich-markdown-editor')).not.toBeVisible()
      expect(readFileSync(filePath, 'utf8')).toBe(saved)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
}
