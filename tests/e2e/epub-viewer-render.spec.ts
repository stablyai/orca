import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const EPUB_NAME = 'orca-minimal-book.epub'
const FIXTURE_EPUB = path.join(__dirname, 'fixtures', EPUB_NAME)

test('renders an EPUB in the editor and pages between chapters', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'epub-view')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  copyFileSync(FIXTURE_EPUB, path.join(fixture.worktreePath, EPUB_NAME))

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  // Why: the toggle's accessible name carries its shortcut ("Explorer (Ctrl+Shift+E)"),
  // and "Refresh Explorer"/"More Explorer Actions" also contain the word — anchor to
  // the start so only the toggle matches.
  await orcaPage
    .getByRole('button', { name: /^Explorer/ })
    .first()
    .click()

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  const epubRow = explorer.locator('[data-file-explorer-row]').filter({
    has: orcaPage.locator('[data-file-explorer-row-name]').getByText(EPUB_NAME, { exact: true })
  })
  await expect(epubRow).toBeVisible({ timeout: 10_000 })
  await epubRow.click()

  await expect(orcaPage.locator('.editor-header-path').first()).toContainText(EPUB_NAME, {
    timeout: 20_000
  })

  // The viewer's footer confirms EpubViewer mounted (not the "binary file" fallback).
  await expect(orcaPage.getByText('EPUB preview')).toBeVisible({ timeout: 25_000 })

  // epub.js renders chapter content inside an iframe — read through it to prove
  // the book actually rendered, not just that the component mounted.
  const bookFrame = orcaPage.frameLocator('iframe')
  await expect(bookFrame.getByText('ORCA_EPUB_CHAPTER_ONE_MARKER')).toBeVisible({
    timeout: 25_000
  })

  await orcaPage.screenshot({
    path: path.join(process.env.SCREENSHOT_DIR || '/tmp/shots', 'epub-chapter-one.png')
  })

  // Jump to the second chapter via the table of contents.
  await orcaPage.getByRole('button', { name: 'Table of contents' }).click()
  await orcaPage.getByRole('button', { name: 'The Second Chapter' }).click()
  await expect(bookFrame.getByText('ORCA_EPUB_CHAPTER_TWO_MARKER')).toBeVisible({
    timeout: 25_000
  })

  await orcaPage.screenshot({
    path: path.join(process.env.SCREENSHOT_DIR || '/tmp/shots', 'epub-chapter-two.png')
  })
})
