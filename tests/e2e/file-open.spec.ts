import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('clicking a file in the file explorer opens it in an editor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    const filesBefore = await getOpenFiles(orcaPage, worktreeId)

    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md'
    ])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    await expect
      .poll(async () => (await getOpenFiles(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)

    // Assert the rendered path; allow first-open lazy EditorPanel/Monaco/Markdown chunks to mount.
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText(clickedFile!, {
      timeout: 20_000
    })
  })

  test('opening a .md file shows markdown content', async ({ orcaPage }) => {
    await openFileExplorer(orcaPage)
    const clickedFile = await clickFileInExplorer(orcaPage, ['README.md', 'CLAUDE.md'])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    // Assert the file’s real heading so a blank editor cannot pass via store state.
    const expectedHeading = clickedFile?.endsWith('README.md')
      ? /Orca E2E Test Repo/i
      : /CLAUDE\.md/i
    // Allow cold EditorPanel → Markdown chunk loading and ProseMirror boot before the heading paints.
    await expect(orcaPage.getByRole('heading', { name: expectedHeading, level: 1 })).toBeVisible({
      timeout: 25_000
    })
  })
})
