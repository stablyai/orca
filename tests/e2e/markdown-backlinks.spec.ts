import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('Backlinks lists the notes that link to the open note and opens them', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const folder = path.join(seededRepoPath, 'backlink-notes')
  mkdirSync(path.join(folder, 'daily'), { recursive: true })
  registerPostElectronShutdownCleanup(async () => rmSync(folder, { recursive: true, force: true }))
  writeFileSync(path.join(folder, 'rocket-engine.md'), '# Rocket engine\n\nThrust notes.\n')
  writeFileSync(
    path.join(folder, 'daily', '2026-10-16.md'),
    '# Daily\n\nWorked on [[rocket-engine|the engine]] today.\n'
  )
  writeFileSync(
    path.join(folder, 'index.md'),
    '# Index\n\n- [Engine](./rocket-engine.md)\n- rocket-engine is only mentioned here\n'
  )
  writeFileSync(path.join(folder, 'unrelated.md'), '# Unrelated\n\n[[index]]\n')

  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const filePath = path.join(folder, 'rocket-engine.md')
  await orcaPage.evaluate(
    ({ filePath, worktreeId }) => {
      window.__store!.getState().openMarkdownPreview({
        filePath,
        relativePath: 'backlink-notes/rocket-engine.md',
        worktreeId,
        language: 'markdown'
      })
    },
    { filePath, worktreeId }
  )
  await expect(orcaPage.getByRole('heading', { name: 'Rocket engine' })).toBeVisible()

  const toggle = orcaPage.getByRole('button', { name: /^Backlinks/ })
  await toggle.click()
  await expect(toggle).toContainText('(2)')
  const panel = toggle.locator('xpath=ancestor::section[1]')
  await expect(panel).toContainText('backlink-notes/daily/2026-10-16.md')
  await expect(panel).toContainText('backlink-notes/index.md')
  await expect(panel).not.toContainText('unrelated.md')
  await panel.screenshot({ path: testInfo.outputPath('backlinks-panel.png') })
  await orcaPage.screenshot({ path: testInfo.outputPath('backlinks.png') })

  await panel.getByRole('button', { name: /daily\/2026-10-16\.md/ }).click()
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        return state.openFiles.find((entry) => entry.id === state.activeFileId)?.relativePath
      })
    )
    .toContain('2026-10-16.md')
})
