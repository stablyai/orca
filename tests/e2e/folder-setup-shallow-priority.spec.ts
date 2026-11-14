import { openSidebarProjectMenu } from './helpers/sidebar-project-dialog'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []
const IMPORT_AS_GROUP_BUTTON_NAME = 'Yes, import as group'

function initializeGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${path.basename(repoPath)}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
}

async function createShallowPriorityTruncationFixture(): Promise<{
  parentPath: string
  webClientPath: string
  groupName: string
}> {
  // Resolve macOS /var symlinks like import does when recording project paths.
  const parentPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-shallow-priority-'))
  )
  tempRoots.push(parentPath)
  const archivePath = path.join(parentPath, 'archive')
  const webClientPath = path.join(parentPath, 'z-web-client')

  for (let index = 1; index <= 101; index += 1) {
    const repoName = `archived-service-${String(index).padStart(3, '0')}`
    // Only repo markers matter to this scan; avoid initializing 101 unused git repositories.
    mkdirSync(path.join(archivePath, repoName, '.git'), { recursive: true })
  }
  initializeGitRepo(webClientPath)

  return {
    parentPath,
    webClientPath,
    groupName: path.basename(parentPath)
  }
}

async function chooseFolderInNativeDialog(
  electronApp: ElectronApplication,
  folderPath: string
): Promise<void> {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
      bookmarks: []
    })
  }, folderPath)
}

function getImportAsGroupButton(importDialog: Locator): Locator {
  // Require the current accessible action so retired labels cannot hide copy drift.
  return importDialog.getByRole('button', {
    name: IMPORT_AS_GROUP_BUTTON_NAME,
    exact: true
  })
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prioritizes shallow sibling repositories in a bounded nested scan', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const fixture = await createShallowPriorityTruncationFixture()
  await chooseFolderInNativeDialog(electronApp, fixture.parentPath)

  await openSidebarProjectMenu(orcaPage)
  await orcaPage.getByRole('menuitem', { name: /Browse folder/i }).click()

  const importDialog = orcaPage.getByRole('dialog', {
    name: /Import repositories from folder/i
  })
  await expect(importDialog.getByText('z-web-client', { exact: true }).first()).toBeVisible()

  await importDialog.getByLabel('Deselect all').click()
  await importDialog
    .locator('label')
    .filter({ hasText: 'z-web-client' })
    .locator('input[type="checkbox"]')
    .check()
  await getImportAsGroupButton(importDialog).click()

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (args) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const group = state.projectGroups.find((entry) => entry.parentPath === args.parentPath)
            const importedRepo = state.repos.find((repo) => repo.path === args.webClientPath)
            return {
              groupName: group?.name ?? null,
              groupParentPath: group?.parentPath ?? null,
              importedRepoPath: importedRepo?.path ?? null,
              importedRepoName: importedRepo?.displayName ?? null,
              repoInCreatedGroup: group !== undefined && importedRepo?.projectGroupId === group.id,
              importedArchiveCount: state.repos.filter((repo) =>
                repo.path.includes(`${args.pathSeparator}archive${args.pathSeparator}`)
              ).length
            }
          },
          { ...fixture, pathSeparator: path.sep }
        ),
      {
        timeout: 20_000,
        message: 'shallow repo from truncated nested scan was not imported into the group'
      }
    )
    .toEqual({
      groupName: fixture.groupName,
      groupParentPath: fixture.parentPath,
      importedRepoPath: fixture.webClientPath,
      importedRepoName: 'z-web-client',
      repoInCreatedGroup: true,
      importedArchiveCount: 0
    })

  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.closeModal()
    state?.setGroupBy('repo')
  })
  await expect(orcaPage.getByText(fixture.groupName)).toBeVisible()
  await expect(orcaPage.getByText('z-web-client').first()).toBeVisible()
})
