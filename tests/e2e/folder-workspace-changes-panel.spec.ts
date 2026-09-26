/**
 * Folder workspace "Workspace changes" panel: sibling git repos under a folder
 * workspace, only dirty repos listed, live refresh on disk edits, and a
 * repo-wide discard that goes through the folder-scope git authorization.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type MetaRepoLayout = {
  folderPath: string
  repoPaths: Record<'api' | 'web' | 'shared' | 'docs', string>
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function createChildRepo(folderPath: string, name: string): string {
  const repoPath = path.join(folderPath, name)
  mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  git(repoPath, 'init', '-b', 'main')
  git(repoPath, 'config', 'user.email', 'e2e@test.local')
  git(repoPath, 'config', 'user.name', 'E2E Test')
  writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n`)
  writeFileSync(path.join(repoPath, 'src', 'index.ts'), `export const name = '${name}'\n`)
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', 'Initial commit')
  return repoPath
}

function createMetaRepoLayout(): MetaRepoLayout {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-meta-')))
  const repoPaths = {
    api: createChildRepo(folderPath, 'api'),
    web: createChildRepo(folderPath, 'web'),
    shared: createChildRepo(folderPath, 'shared'),
    docs: createChildRepo(folderPath, 'docs')
  }
  // api: one modified tracked file and one untracked file.
  writeFileSync(path.join(repoPaths.api, 'src', 'index.ts'), "export const name = 'api-v2'\n")
  writeFileSync(path.join(repoPaths.api, 'src', 'routes.ts'), 'export const routes = []\n')
  // web: one staged new file.
  writeFileSync(path.join(repoPaths.web, 'src', 'app.tsx'), 'export const App = () => null\n')
  git(repoPaths.web, 'add', 'src/app.tsx')
  return { folderPath, repoPaths }
}

test.describe('folder workspace changes panel', () => {
  let layout: MetaRepoLayout

  // Why: Windows keeps the watched folder locked until Electron exits, so the
  // cleanup must run after the electronApp fixture teardown.
  test.beforeEach(({ registerPostElectronShutdownCleanup }) => {
    layout = createMetaRepoLayout()
    registerPostElectronShutdownCleanup(async () => {
      rmSync(layout.folderPath, { recursive: true, force: true })
    })
  })

  test('lists only dirty sibling repos, refreshes on disk edits, and discards a repo', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)

    const folderWorktreeId = await orcaPage.evaluate(async (folderPath) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const group = await window.api.projectGroups.create({
        name: 'Meta repo E2E',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      await state.fetchProjectGroups()
      const workspace = await state.createFolderWorkspace({
        projectGroupId: group.id,
        name: 'Meta repo E2E',
        folderPath
      })
      if (!workspace) {
        throw new Error('Could not create folder workspace')
      }
      const worktreeId = `folder:${workspace.id}`
      store.getState().setActiveWorktree(worktreeId)
      store.getState().setRightSidebarOpen(true)
      store.getState().setRightSidebarTab('workspace-changes')
      return worktreeId
    }, layout.folderPath)

    const repoSections = orcaPage.locator('[data-testid="folder-workspace-changes-repo"]')
    await expect(repoSections).toHaveCount(2, { timeout: 30_000 })
    await expect(repoSections.nth(0)).toContainText('api')
    await expect(repoSections.nth(1)).toContainText('web')
    await expect(orcaPage.getByText('2 of 4 repos · 3 files')).toBeVisible()
    await expect(orcaPage.locator('[data-testid="source-control-entry"]')).toHaveCount(3)

    const afterScreenshot = testInfo.outputPath('workspace-changes-panel.png')
    await orcaPage.screenshot({
      path: afterScreenshot,
      animations: 'disabled'
    })
    await testInfo.attach('workspace-changes-panel', {
      path: afterScreenshot,
      contentType: 'image/png'
    })

    // A clean repo becomes dirty on disk: the watcher on the folder root picks it up.
    writeFileSync(path.join(layout.repoPaths.shared, 'README.md'), '# shared\n\nEdited outside.\n')
    await expect(repoSections).toHaveCount(3, { timeout: 30_000 })
    await expect(repoSections.nth(1)).toContainText('shared')

    // Clicking a file opens a diff tab owned by the folder workspace.
    await orcaPage.locator('[data-source-control-path="src/index.ts"]').first().click()
    await expect
      .poll(async () =>
        orcaPage.evaluate(
          (worktreeId) =>
            window.__store
              ?.getState()
              .openFiles.filter((file) => file.worktreeId === worktreeId && file.mode === 'diff')
              .map((file) => file.relativePath) ?? [],
          folderWorktreeId
        )
      )
      .toEqual(['src/index.ts'])

    // Discard all changes in api: modified file restored, untracked file deleted.
    await orcaPage.getByRole('button', { name: 'Discard all changes in api' }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toContainText('Discard all changes in "api"?')
    await dialog.getByRole('button', { name: 'Discard all' }).click()
    await expect(repoSections).toHaveCount(2, { timeout: 30_000 })
    await expect(repoSections.nth(0)).toContainText('shared')
    await expect
      .poll(() =>
        execFileSync('git', ['status', '--porcelain'], {
          cwd: layout.repoPaths.api,
          encoding: 'utf8'
        }).trim()
      )
      .toBe('')
  })
})
