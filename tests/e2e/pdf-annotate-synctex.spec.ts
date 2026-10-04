import { rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createPdfParagraphFixture } from './helpers/pdf-paragraph-fixture'
import { createParagraphFixtureSynctex } from './helpers/pdf-paragraph-synctex'

const PAGE_WIDTH_PT = 612
// main.tex line for each fixture line: heading, the four-line paragraph, the indented one.
const SOURCE_LINES = [3, 5, 6, 7, 8, 10, 11]

async function pdfToClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('.pdfViewer .page[data-page-number="1"]').boundingBox()
  if (!box) {
    throw new Error('PDF page is not laid out')
  }
  const scale = box.width / PAGE_WIDTH_PT
  return { x: box.x + x * scale, y: box.y + y * scale }
}

test('PDF annotations carry their TeX source lines and warn when the PDF is stale', async ({
  orcaPage,
  electronApp,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const pdfPath = path.join(seededRepoPath, 'pdf-synctex-fixture.pdf')
  const synctexPath = path.join(seededRepoPath, 'pdf-synctex-fixture.synctex.gz')
  const texPath = path.join(seededRepoPath, 'main.tex')
  writeFileSync(texPath, '% source for the SyncTeX fixture\n')
  writeFileSync(pdfPath, createPdfParagraphFixture())
  writeFileSync(synctexPath, gzipSync(createParagraphFixtureSynctex(texPath, SOURCE_LINES)))
  const now = Date.now() / 1000
  utimesSync(texPath, now - 60, now - 60)
  utimesSync(pdfPath, now - 30, now - 30)
  registerPostElectronShutdownCleanup(async () => {
    for (const file of [pdfPath, synctexPath, texPath]) {
      rmSync(file, { force: true })
    }
  })
  // Why: the host OS locale drives the UI language; pin English so locators are stable.
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ uiLanguage: 'en', theme: 'light' })
  )
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-synctex-fixture.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, pdfPath)
  await expect(orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
    'The first paragraph'
  )
  const card = orcaPage.getByRole('dialog', { name: 'Add PDF annotation' })
  const copyPrompt = async (name: string): Promise<string> => {
    await orcaPage.getByRole('button', { name: 'Copy' }).click()
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('## PDF Feedback')
    const prompt = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    writeFileSync(testInfo.outputPath(`${name}.md`), prompt)
    await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''))
    return prompt
  }

  await orcaPage.getByRole('button', { name: 'Annotate PDF' }).click()
  const firstParagraph = await pdfToClient(orcaPage, 200, 155)
  await orcaPage.mouse.click(firstParagraph.x, firstParagraph.y)
  await expect(card).toContainText('p.1 "The first paragraph opens')
  await card.getByRole('textbox').fill('Split this into two sentences')
  await card.getByRole('button', { name: /Add/ }).click()
  await expect(orcaPage.getByText('1 annotation', { exact: true })).toBeVisible()

  const fresh = await copyPrompt('prompt-fresh')
  expect(fresh).toContain('**Source:** main.tex:5-8')
  expect(fresh).not.toContain('**Warning:**')

  // The agent edits the source after the build: the next prompt says the lines may be off.
  utimesSync(texPath, now, now)
  const stale = await copyPrompt('prompt-stale')
  expect(stale).toContain(
    '**Warning:** `main.tex` changed after this PDF was built, so the source lines below may be off.'
  )
  expect(stale).toContain('**Source:** main.tex:5-8')
})
