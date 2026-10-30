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

async function switchToTerminal(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, worktreeId)
}

async function switchToEditor(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((targetFileId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    if (state.openFiles.some((file) => file.id === targetFileId)) {
      state.setActiveFile(targetFileId)
      state.setActiveTabType('editor', store.getState().activeWorktreeId)
    }
  }, fileId)
}

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('opening the right sidebar shows file explorer', async ({ orcaPage }) => {
    await openFileExplorer(orcaPage)

    // Assert the rendered explorer shell; store selection alone cannot detect mount failure.
    await expect(orcaPage.locator('[data-orca-explorer-shell]')).toBeVisible({ timeout: 5_000 })
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

  test('editor tab retains state when switching to terminal and back', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore'
    ])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 }).toBe('editor')

    const openFilesBefore = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    const editorFileId = openFilesBefore[0].id

    await switchToTerminal(orcaPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).not.toBe('editor')

    await switchToEditor(orcaPage, editorFileId)
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('editor')

    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
