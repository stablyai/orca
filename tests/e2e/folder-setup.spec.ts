import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { ElectronApplication, Locator } from '@stablyai/playwright-test'

const IMPORT_AS_GROUP_BUTTON_NAME = 'Yes, import as group'

const tempRoots: string[] = []

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

async function createNestedRepoFixture(): Promise<{
  parentPath: string
  projectPaths: string[]
  groupName: string
}> {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-folder-setup-'))
  tempRoots.push(parentPath)
  const repoNames = ['api-service', 'web-client']
  const projectPaths = repoNames.map((name) => path.join(parentPath, name))

  for (const repoPath of projectPaths) {
    initializeGitRepo(repoPath)
  }

  return {
    parentPath,
    projectPaths,
    groupName: path.basename(parentPath)
  }
}

async function createLargeNestedRepoFixture(): Promise<{
  parentPath: string
  projectPaths: string[]
  groupName: string
  selectedProjectPaths: string[]
}> {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-large-folder-setup-'))
  tempRoots.push(parentPath)
  const nestedParent = path.join(
    parentPath,
    'products-with-long-folder-name',
    'platform-domain-with-long-folder-name',
    'region-alpha-with-long-folder-name'
  )
  const projectPaths = Array.from({ length: 87 }, (_, index) => {
    const repoName = `service-${String(index + 1).padStart(2, '0')}-with-long-repository-name`
    return path.join(nestedParent, repoName)
  })

  for (const repoPath of projectPaths) {
    initializeGitRepo(repoPath)
  }

  return {
    parentPath,
    projectPaths,
    groupName: path.basename(parentPath),
    selectedProjectPaths: [projectPaths[2], projectPaths[41], projectPaths[86]]
  }
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

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
  // Why: the current accessible action is intentional; accepting retired
  // labels would hide deterministic dialog copy drift.
  return importDialog.getByRole('button', {
    name: IMPORT_AS_GROUP_BUTTON_NAME,
    exact: true
  })
}

test.describe('Folder setup', () => {
  test('imports nested repositories from the add-project dialog as a project group', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createNestedRepoFixture()
    await chooseFolderInNativeDialog(electronApp, fixture.parentPath)

    await orcaPage
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    const dialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /Browse folder/i }).click()

    const importDialog = orcaPage.getByRole('dialog', {
      name: /Import repositories from folder/i
    })
    await expect(
      importDialog.getByRole('heading', { name: /Import repositories from folder/i })
    ).toBeVisible()
    await expect(importDialog.getByText('api-service', { exact: true }).first()).toBeVisible()
    await expect(importDialog.getByText('web-client', { exact: true }).first()).toBeVisible()
    await expect(getImportAsGroupButton(importDialog)).toBeEnabled()
    await getImportAsGroupButton(importDialog).click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(async (args) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const importedRepos = state.repos
              .filter((repo) => args.projectPaths.includes(repo.path))
              .sort((left, right) => left.displayName.localeCompare(right.displayName))
            const group = state.projectGroups.find((entry) => entry.parentPath === args.parentPath)
            return {
              groupName: group?.name ?? null,
              repoNames: importedRepos.map((repo) => repo.displayName),
              reposInCreatedGroup:
                group !== undefined &&
                importedRepos.every((repo) => repo.projectGroupId === group.id),
              projectGroupOrders: importedRepos.map((repo) => repo.projectGroupOrder ?? null)
            }
          }, fixture),
        {
          timeout: 20_000,
          message: 'nested repos were not imported into a project group'
        }
      )
      .toEqual({
        groupName: fixture.groupName,
        repoNames: ['api-service', 'web-client'],
        reposInCreatedGroup: true,
        projectGroupOrders: [0, 1]
      })

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.closeModal()
      state?.setGroupBy('repo')
    })
    await expect(orcaPage.getByText(fixture.groupName)).toBeVisible()
  })

  test('imports a small selection from a large nested folder without modal overflow', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createLargeNestedRepoFixture()
    await chooseFolderInNativeDialog(electronApp, fixture.parentPath)

    await orcaPage
      .getByRole('button', { name: /Add Project/i })
      .first()
      .click()
    const dialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /Browse folder/i }).click()

    const importDialog = orcaPage.getByRole('dialog', {
      name: /Import repositories from folder/i
    })
    await expect(importDialog.getByText(/Found 87 repositories in/)).toBeVisible()
    await expect
      .poll(async () =>
        importDialog.locator('ul').evaluate((list) => {
          const dialog = list.closest('[role="dialog"]')
          if (!dialog) {
            return 0
          }
          const dialogRight = dialog.getBoundingClientRect().right
          return [...list.querySelectorAll('li, label, span')].filter(
            (node) => node.getBoundingClientRect().right > dialogRight + 1
          ).length
        })
      )
      .toBe(0)

    await importDialog.getByLabel('Deselect all').click()
    for (const projectPath of fixture.selectedProjectPaths) {
      const repoName = path.basename(projectPath)
      await importDialog
        .locator('label')
        .filter({ hasText: repoName })
        .locator('input[type="checkbox"]')
        .check()
    }
    await getImportAsGroupButton(importDialog).click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(async (args) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const importedRepos = state.repos.filter((repo) =>
              args.selectedProjectPaths.includes(repo.path)
            )
            const fixtureRepos = state.repos.filter((repo) => args.projectPaths.includes(repo.path))
            const group = state.projectGroups.find((entry) => entry.parentPath === args.parentPath)
            const groupsById = new Map(state.projectGroups.map((entry) => [entry.id, entry]))
            const isInGroupSubtree = (groupId: string | null | undefined): boolean => {
              let currentId = groupId ?? null
              while (currentId) {
                if (currentId === group?.id) {
                  return true
                }
                currentId = groupsById.get(currentId)?.parentGroupId ?? null
              }
              return false
            }
            const worktreeCounts = await Promise.all(
              importedRepos.map(async (repo) => {
                const result = await window.api.worktrees.listDetected({ repoId: repo.id })
                return result.worktrees.length
              })
            )
            return {
              importedCount: importedRepos.length,
              fixtureImportCount: fixtureRepos.length,
              allSelectedInGroup:
                group !== undefined &&
                importedRepos.every((repo) => isInGroupSubtree(repo.projectGroupId)),
              allSelectedHaveWorktrees:
                importedRepos.length === args.selectedProjectPaths.length &&
                worktreeCounts.every((count) => count > 0)
            }
          }, fixture),
        {
          timeout: 20_000,
          message: 'selected repos from the large nested scan were not imported into the group'
        }
      )
      .toEqual({
        importedCount: 3,
        fixtureImportCount: 3,
        allSelectedInGroup: true,
        allSelectedHaveWorktrees: true
      })
  })
})
