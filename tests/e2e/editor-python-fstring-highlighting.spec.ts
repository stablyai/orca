import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const source = ['x = f"""', 'SELECT 1', '"""', '', 'with open("f.txt") as dag:', '    pass'].join(
  '\n'
)

async function expectHighlighted(surface: Locator): Promise<void> {
  await expect(surface).toContainText('SELECT')
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        const colorOf = (text: string) => {
          const span = [...element.querySelectorAll('span[class*="mtk"]')].find((entry) =>
            entry.textContent?.includes(text)
          )
          return span ? getComputedStyle(span).color : null
        }
        const keyword = colorOf('with')
        const body = colorOf('SELECT')
        return keyword !== null && body !== null && keyword !== body
      })
    )
    .toBe(true)
}

for (const kind of ['source', 'notebook'] as const) {
  test(`keeps code after a multiline f-string highlighted in ${kind}`, async ({
    orcaPage,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const fixture = createGoldenWorktree(testRepoPath, `python-fstring-${kind}`)
    registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
    const filePath = path.join(fixture.worktreePath, kind === 'source' ? 'query.py' : 'query.ipynb')
    const content =
      kind === 'source'
        ? source
        : JSON.stringify({
            nbformat: 4,
            nbformat_minor: 5,
            metadata: { language_info: { name: 'python' } },
            cells: [
              {
                id: 'query',
                cell_type: 'code',
                metadata: {},
                execution_count: null,
                outputs: [],
                source: [source]
              }
            ]
          })
    writeFileSync(filePath, content)
    await waitForSessionReady(orcaPage)
    await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
    await orcaPage.evaluate(
      ({ filePath, relativePath, language }) => {
        const store = window.__store
        const worktreeId = store?.getState().activeWorktreeId
        if (!store || !worktreeId) {
          throw new Error('Python fixture worktree unavailable')
        }
        store.getState().openFile({ filePath, relativePath, worktreeId, language, mode: 'edit' })
      },
      {
        filePath,
        relativePath: path.basename(filePath),
        language: kind === 'source' ? 'python' : 'json'
      }
    )
    const surface = orcaPage.locator(
      kind === 'source' ? '.monaco-editor .view-lines' : '.ipynb-code-surface'
    )
    await expectHighlighted(surface)
    await orcaPage.screenshot({ path: testInfo.outputPath(`python-${kind}.png`) })

    if (kind === 'notebook') {
      await surface.getByRole('button').click()
      await expectHighlighted(surface.locator('.view-lines'))
      await orcaPage.screenshot({ path: testInfo.outputPath('python-notebook-active.png') })
    }
  })
}
