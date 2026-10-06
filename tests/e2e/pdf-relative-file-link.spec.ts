import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { createPdfRelativeLinkFixture } from './helpers/pdf-relative-link-fixture'

const LINK_TARGET = '../pdf-link-papers/cited-paper.pdf'

/** Lays out `pdf-link-out/notes.pdf` linking to `pdf-link-papers/cited-paper.pdf`. */
function writeLinkedPdfs(root: string): { filePath: string; cleanup: () => void } {
  const buildDir = path.join(root, 'pdf-link-out')
  const papersDir = path.join(root, 'pdf-link-papers')
  mkdirSync(buildDir, { recursive: true })
  mkdirSync(papersDir, { recursive: true })
  const filePath = path.join(buildDir, 'notes.pdf')
  writeFileSync(filePath, createPdfRelativeLinkFixture(LINK_TARGET))
  writeFileSync(path.join(papersDir, 'cited-paper.pdf'), createPdfFindFixture())
  return {
    filePath,
    cleanup: () => {
      rmSync(buildDir, { recursive: true, force: true })
      rmSync(papersDir, { recursive: true, force: true })
    }
  }
}

async function expectLinkOpensCitedPaper(
  orcaPage: Page,
  screenshotPath: (name: string) => string
): Promise<void> {
  await expect(orcaPage.locator('.pdfViewer .page .textLayer')).toContainText(
    'Open the cited paper'
  )
  const link = orcaPage.locator('.pdfViewer .annotationLayer section[role="link"]')
  await expect(link).toHaveAttribute('title', LINK_TARGET)
  await orcaPage.screenshot({ path: screenshotPath('before-click.png') })
  await link.click()

  await expect(orcaPage.locator('.pdfViewer .page')).toHaveCount(3)
  await expect(orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
    'needle result 1'
  )
  const activeRelativePath = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    return state?.openFiles.find((file) => file.id === state.activeFileId)?.relativePath
  })
  expect(activeRelativePath).toBe('pdf-link-papers/cited-paper.pdf')
  await orcaPage.screenshot({ path: screenshotPath('after-click.png') })
}

test('a PDF link to a sibling file opens that file in Orca', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const { filePath, cleanup } = writeLinkedPdfs(seededRepoPath)
  registerPostElectronShutdownCleanup(async () => cleanup())

  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-link-out/notes.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)

  await expectLinkOpensCitedPaper(orcaPage, (name) => testInfo.outputPath(name))
})

test.describe('PDF link in a folder workspace', () => {
  test.use({ seedTestRepo: false })

  test('opens the sibling file without a Git repository', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const folderPath = mkdtempSync(path.join(os.tmpdir(), 'orca-pdf-link-folder-'))
    const { filePath } = writeLinkedPdfs(folderPath)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(folderPath, { recursive: true, force: true })
    )

    await orcaPage.evaluate(
      async ({ folderPath, filePath }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing fixture store')
        }
        const group = await window.api.projectGroups.create({
          name: 'PDF link fixture',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups()
        const folder = await state.createFolderWorkspace({
          projectGroupId: group.id,
          name: 'PDF documents',
          folderPath
        })
        if (!folder) {
          throw new Error('Missing fixture folder')
        }
        const worktreeId = `folder:${folder.id}`
        state.setActiveWorktree(worktreeId)
        state.openFile({
          filePath,
          relativePath: 'pdf-link-out/notes.pdf',
          worktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { folderPath, filePath }
    )

    await expectLinkOpensCitedPaper(orcaPage, (name) => testInfo.outputPath(name))
  })
})
