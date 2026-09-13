import { rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
for (const surface of ['file', 'combined']) {
  test(`reveals an offscreen note in the ${surface} diff and supports repeated jumps`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const original = Array.from(
      { length: 600 },
      (_, index) => `export const value${index} = ${index}\n`
    ).join('')
    const fixture = createIsolatedLargeDiffRepo(original)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, original.replace('value2 = 2', 'value2 = 999'))
    await waitForSessionReady(orcaPage)
    const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
    const note = await orcaPage.evaluate(
      async ({ worktreeId, filePath }) => {
        return window.__store!.getState().addDiffComment({
          worktreeId,
          filePath,
          source: 'diff',
          lineNumber: 450,
          body: 'Jump to this unchanged line',
          side: 'modified'
        })
      },
      { worktreeId, filePath: fixture.relativePath }
    )
    if (!note) {
      throw new Error('Could not seed note')
    }
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    const openDiff =
      surface === 'combined'
        ? orcaPage.getByRole('button', { name: 'View all', exact: true }).first()
        : orcaPage.locator('[data-testid="source-control-entry"]').first()
    await openDiff.click()
    await expect(
      orcaPage.locator('diffs-container [data-content] [data-line]').first()
    ).toBeVisible({ timeout: 20_000 })
    const card = orcaPage.locator(`[data-diff-comment-id="${note.id}"]`)
    for (let attempt = 0; attempt < 2; attempt++) {
      await orcaPage.locator('diffs-container').evaluate((host) => {
        host.closest('.scrollbar-editor')!.scrollTop = 0
      })
      if (surface === 'file') {
        const expandNotes = orcaPage.getByTitle('Expand notes', { exact: true })
        if (await expandNotes.isVisible()) {
          await expandNotes.click()
        }
        await orcaPage.getByRole('button', { name: 'Open note on line 450', exact: true }).click()
      } else {
        await orcaPage.evaluate(
          (id) => window.__store!.getState().setScrollToDiffCommentId(id),
          note.id
        )
      }
      await expect(card).toBeInViewport({ timeout: 15_000 })
      await expect(card).toContainText('Jump to this unchanged line')
      await expect(
        orcaPage
          .locator('diffs-container [data-content] [data-line]')
          .filter({ hasText: 'value449 = 449' })
      ).toBeInViewport()
    }
    await orcaPage.screenshot({ path: testInfo.outputPath(`${surface}-note-jump.png`) })
  })
}
