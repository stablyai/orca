import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const LONG_CELL = 'long cell '.repeat(600).trimEnd()
const SOURCE = `| id | notes |\n| --- | --- |\n| 1 | short |\n| 2 | ${LONG_CELL} |\n| 3 | short |\n| 4 | short |\n`

for (const workspace of ['git', 'folder', 'paired'] as const) {
  test(`saves a new table row without expanding sibling padding in a ${workspace} workspace`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    if (workspace === 'folder') {
      const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-table-padding-')))
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
      'table-padding',
      workspace,
      testInfo.workerIndex,
      SOURCE
    )
    let client: PairedElectronClient | undefined
    try {
      if (workspace === 'paired') {
        client = await launchPairedElectronClient(
          await createRuntimeDesktopPairingOffer(orcaPage),
          testInfo,
          'Table padding save'
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
      const rich = await waitForRichMarkdownEditor(page)
      await expect(rich.locator('tr')).toHaveCount(5)
      await rich.locator('tr').last().locator('td').last().click()
      await page.keyboard.press('Tab')
      await expect(rich.locator('tr')).toHaveCount(6)
      await page.keyboard.insertText('added')
      await page.keyboard.press('ControlOrMeta+S')
      await expect
        .poll(() => readFileSync(filePath, 'utf8'), { timeout: 15_000 })
        .toContain('added')
      const saved = readFileSync(filePath, 'utf8')
      await page.getByRole('radio', { name: 'Source', exact: true }).click()
      await expect(page.locator('.monaco-editor').first()).toBeVisible()
      const proofDirectory = process.env.ORCA_TABLE_PADDING_PROOF_DIR
      if (proofDirectory) {
        mkdirSync(proofDirectory, { recursive: true })
        await page.screenshot({ path: path.join(proofDirectory, `${workspace}.png`) })
        writeFileSync(
          path.join(proofDirectory, `${workspace}.json`),
          JSON.stringify(
            {
              workspace,
              originalLength: SOURCE.length,
              savedLength: saved.length,
              originalLongCellPreserved: saved.includes(LONG_CELL),
              saved
            },
            null,
            2
          )
        )
      }
      await testInfo.attach('saved-source', { body: saved, contentType: 'text/markdown' })
      expect(saved).toContain(LONG_CELL)
      expect(saved.length).toBeLessThan(SOURCE.length + 300)
      expect(
        saved
          .split('\n')
          .filter((line) => line.startsWith('|') && !line.includes(LONG_CELL))
          .every((line) => line.length < 100)
      ).toBe(true)
      await closeActiveEditorTab(page, filePath)
      if (workspace === 'folder') {
        await switchToWorktree(page, context.worktreeId)
      }
      await openMarkdownFixture(page, context, filePath)
      await page.getByRole('radio', { name: 'Rich Editor', exact: true }).click()
      const reopened = await waitForRichMarkdownEditor(page)
      await expect(reopened.locator('tr')).toHaveCount(6)
      await expect(reopened).toContainText('added')
      await expect(reopened).toContainText(LONG_CELL)
      expect(readFileSync(filePath, 'utf8')).toBe(saved)
    } finally {
      await client?.dispose()
      await cleanupMarkdownFixture(filePath)
    }
  })
}
