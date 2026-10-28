import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { switchToWorktree, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'

const SOURCE = '# Compatibility\n\n[[]] [[a|]]\n\n[**Bold**](https://example.com)\n\nEnd\n'
const TYPED = '[typed](./target.md)'

for (const workspace of ['git', 'folder', 'paired remote'] as const) {
  test(`preserves literal Markdown and formatted links when saving in ${workspace}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-markdown-folder-')))
      registerPostElectronShutdownCleanup(async () =>
        rmSync(folder, { recursive: true, force: true })
      )
      await orcaPage.evaluate(async (folderPath) => {
        const repo = await window.__store!.getState().addNonGitFolder(folderPath)
        if (!repo) {
          throw new Error('Could not add folder workspace')
        }
      }, folder)
      await expect
        .poll(async () => (await getActiveWorktreeContext(orcaPage)).rootPath)
        .toBe(folder)
    }
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      'markdown-compatibility',
      workspace.replaceAll(' ', '-'),
      testInfo.workerIndex,
      SOURCE
    )
    let client: PairedElectronClient | undefined
    try {
      if (workspace === 'paired remote') {
        client = await launchPairedElectronClient(
          await createRuntimeDesktopPairingOffer(orcaPage),
          testInfo,
          'Markdown save compatibility'
        )
        await waitForPairedClientWorktree(client.page, context.worktreeId)
        await client.page.evaluate(
          ({ worktreeId, environmentId }) => {
            window.__store!.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
          },
          { worktreeId: context.worktreeId, environmentId: client.environmentId }
        )
      }
      const page = client?.page ?? orcaPage
      await openMarkdownFixture(page, context, filePath)
      if (client) {
        expect(
          await page.evaluate(() => {
            const state = window.__store!.getState()
            return state.openFiles.find((file) => file.id === state.activeFileId)
              ?.runtimeEnvironmentId
          })
        ).toBe(client.environmentId)
      }
      const editor = await waitForRichMarkdownEditor(page)
      await expect(editor).toContainText('[[]] [[a|]]')
      await expect(editor.locator('a strong')).toHaveText('Bold')
      await editor.click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.press('Enter')
      await page.keyboard.insertText(TYPED)
      await expect(editor.locator('a').filter({ hasText: 'typed' })).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+S')
      await expect
        .poll(() => readFileSync(filePath, 'utf8'), { timeout: 15_000 })
        .toContain('typed')
      const saved = readFileSync(filePath, 'utf8')
      expect(saved).toContain('[[]] [[a|]]')
      expect(saved).toContain('[**Bold**](https://example.com)')
      await testInfo.attach('saved-markdown', { body: saved, contentType: 'text/markdown' })
      await closeActiveEditorTab(page, filePath)
      // Closing a folder's only tab intentionally returns to the landing screen.
      if (workspace === 'folder') {
        await switchToWorktree(page, context.worktreeId)
      }
      await openMarkdownFixture(page, context, filePath)
      const reopened = await waitForRichMarkdownEditor(page)
      await expect(reopened).toContainText(TYPED)
      await expect(reopened).toContainText('[[]] [[a|]]')
      await expect(reopened.locator('a strong')).toHaveText('Bold')
      await expect(reopened.locator('a').filter({ hasText: 'typed' })).toHaveCount(0)
      await testInfo.attach('reopened-editor', {
        body: await page.screenshot(),
        contentType: 'image/png'
      })
      await closeActiveEditorTab(page, filePath)
    } finally {
      await client?.dispose()
      await cleanupMarkdownFixture(filePath)
    }
  })
}
