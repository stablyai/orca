import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('Markdown Changes compares the index to working bytes and refreshes on reopen', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'markdown-index-diff')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const relativePath = 'partially-staged.md'
  const filePath = path.join(fixture.worktreePath, relativePath)
  const staged = '# Test\n\nstaged original content\n'
  const working = `${staged}unstaged line\n`
  await writeFile(filePath, staged)
  const stage = async (): Promise<void> => {
    const result = await runProcess({
      program: 'git',
      args: ['add', '--', relativePath],
      cwd: fixture.worktreePath
    })
    expect(result.code, result.stderr).toBe(0)
  }
  await stage()
  await writeFile(filePath, working)
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ diffDefaultView: 'side-by-side' })
  )
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  const row = (area: string) =>
    orcaPage.locator(
      `[data-source-control-path="${relativePath}"][data-source-control-area="${area}"]`
    )
  const original = orcaPage.locator(
    '.original-in-monaco-diff-editor .view-lines[role="presentation"]'
  )
  const modified = orcaPage.locator(
    '.modified-in-monaco-diff-editor .view-lines[role="presentation"]'
  )
  await row('unstaged').dblclick()
  await expect(modified).toContainText('unstaged line')
  await orcaPage.screenshot({ path: testInfo.outputPath('unstaged-baseline.png') })
  await expect(original).toContainText('staged original content')
  await expect(original).not.toContainText('unstaged line')

  await row('staged').dblclick()
  await expect(modified).toContainText('staged original content')
  await expect(modified).not.toContainText('unstaged line')
  await expect(original).not.toContainText('staged original content')

  await stage()
  await writeFile(filePath, `${working}new work after staging\n`)
  await row('unstaged').click()
  await expect(original).toContainText('unstaged line')
  await expect(original).not.toContainText('new work after staging')
  await expect(modified).toContainText('new work after staging')
  await orcaPage.screenshot({ path: testInfo.outputPath('reopened-index-baseline.png') })
  expect(
    await orcaPage.evaluate(
      (filePath) =>
        window.__store?.getState().openFiles.filter((file) => file.filePath === filePath).length,
      filePath
    )
  ).toBe(2)
})
