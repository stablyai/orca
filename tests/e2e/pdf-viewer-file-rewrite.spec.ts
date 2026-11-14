import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'

test('an open generated PDF reloads after a rewrite and remains readable after switching tabs', async ({
  orcaPage,
  seededRepoPath
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  const outputDirectory = path.join(seededRepoPath, 'build')
  mkdirSync(outputDirectory, { recursive: true })
  const filePath = path.join(outputDirectory, 'rewritten.pdf')
  writeFileSync(filePath, createPdfFindFixture({ title: 'Original build', paddingBytes: 4096 }))
  await orcaPage.evaluate(
    ({ filePath, neighborPath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Missing fixture worktree')
      }
      state.openFile({
        filePath: neighborPath,
        relativePath: 'src/index.ts',
        worktreeId: state.activeWorktreeId,
        language: 'typescript',
        mode: 'edit'
      })
      state.openFile({
        filePath,
        relativePath: 'build/rewritten.pdf',
        worktreeId: state.activeWorktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { filePath, neighborPath: path.join(seededRepoPath, 'src', 'index.ts') }
  )
  const pageText = orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')
  await expect(pageText).toContainText('Original build - page 1')
  await orcaPage.screenshot({ path: testInfo.outputPath('original.png') })

  writeFileSync(filePath, createPdfFindFixture({ title: 'Rebuilt PDF' }))
  await expect(pageText).toContainText('Rebuilt PDF - page 1')
  await orcaPage.screenshot({ path: testInfo.outputPath('after-rewrite.png') })
  await orcaPage.locator('[data-tab-id]').filter({ hasText: 'index.ts' }).click()
  await expect(orcaPage.locator('.pdfViewer')).toHaveCount(0)
  writeFileSync(filePath, createPdfFindFixture({ title: 'Background build', paddingBytes: 2048 }))
  await orcaPage.locator('[data-tab-id]').filter({ hasText: 'rewritten.pdf' }).click()
  await expect(pageText).toContainText('Background build - page 1')
  await orcaPage.screenshot({ path: testInfo.outputPath('after-switch-back.png') })

  const replacementPath = path.join(outputDirectory, 'replacement.pdf')
  writeFileSync(replacementPath, createPdfFindFixture({ title: 'Atomic replacement' }))
  renameSync(replacementPath, filePath)
  await expect(pageText).toContainText('Atomic replacement - page 1')
  await orcaPage.screenshot({ path: testInfo.outputPath('after-atomic-replacement.png') })
})
