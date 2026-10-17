import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('the note graph draws linked notes and opens the one you click', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const folder = path.join(seededRepoPath, 'graph-notes')
  mkdirSync(folder, { recursive: true })
  registerPostElectronShutdownCleanup(async () => rmSync(folder, { recursive: true, force: true }))
  writeFileSync(
    path.join(folder, 'propulsion.md'),
    '# Propulsion\n\n[[nozzle]] and [[combustion]]\n'
  )
  writeFileSync(
    path.join(folder, 'nozzle.md'),
    '# Nozzle\n\nPart of [propulsion](propulsion.md).\n'
  )
  writeFileSync(path.join(folder, 'combustion.md'), '# Combustion\n\nSee [[nozzle]].\n')
  writeFileSync(path.join(folder, 'island.md'), '# Island\n\nNo links here.\n')

  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(
    ({ filePath, worktreeId }) => {
      window.__store!.getState().openMarkdownPreview({
        filePath,
        relativePath: 'graph-notes/propulsion.md',
        worktreeId,
        language: 'markdown'
      })
    },
    { filePath: path.join(folder, 'propulsion.md'), worktreeId }
  )
  await expect(orcaPage.getByRole('heading', { name: 'Propulsion' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Graph', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog')
  const graph = dialog.getByRole('img', { name: 'Note graph' })
  await expect(graph).toBeVisible()
  for (const note of ['propulsion', 'nozzle', 'combustion']) {
    await expect(graph.getByRole('button', { name: `graph-notes/${note}.md` })).toBeVisible()
  }
  await expect(graph.getByRole('button', { name: 'graph-notes/island.md' })).toHaveCount(0)
  await expect(dialog).toContainText('links')
  await dialog.screenshot({ path: testInfo.outputPath('note-graph.png') })

  await graph.getByRole('button', { name: 'graph-notes/nozzle.md' }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const state = window.__store!.getState()
        return state.openFiles.find((entry) => entry.id === state.activeFileId)?.relativePath
      })
    )
    .toContain('nozzle.md')
})
