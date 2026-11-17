import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext
} from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

function document(): string {
  return `# Notes\n\n${Array.from({ length: 120 }, (_, index) => `Paragraph ${index}. ${'Readable body text. '.repeat(8)}`).join('\n\n')}\n`
}

test('adding a review note keeps the preview scroll position', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-note-scroll',
    'notes',
    testInfo.workerIndex,
    document()
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await orcaPage.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      window
        .__store!.getState()
        .openMarkdownPreview({ filePath, relativePath, worktreeId, language: 'markdown' })
    },
    {
      filePath,
      relativePath: path.relative(context.rootPath, filePath),
      worktreeId: context.worktreeId
    }
  )
  const preview = orcaPage.locator('.markdown-preview')
  for (const [index, text] of ['Paragraph 100.', 'Paragraph 101.'].entries()) {
    const block = preview.locator('.markdown-annotation-block').filter({ hasText: text })
    await block.scrollIntoViewIfNeeded()
    await block.hover()
    await block.getByRole('button', { name: 'Add note', exact: true }).click()
    const composer = preview.getByPlaceholder('Add note for the AI')
    await composer.fill(`Keep my place ${index}`)
    const before = await preview.evaluate((element) => element.scrollTop)
    expect(before).toBeGreaterThan(1000)
    await composer.press('Enter')
    await expect(preview.getByText(`Keep my place ${index}`, { exact: true })).toBeVisible()
    await expect(block).toBeInViewport()
    expect(
      Math.abs((await preview.evaluate((element) => element.scrollTop)) - before)
    ).toBeLessThan(200)
  }
})
