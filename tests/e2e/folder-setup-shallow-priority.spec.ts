import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

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

async function createShallowPriorityTruncationFixture(): Promise<{
  parentPath: string
  webClientPath: string
  groupName: string
}> {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-shallow-priority-'))
  tempRoots.push(parentPath)
  const archivePath = path.join(parentPath, 'archive')
  const webClientPath = path.join(parentPath, 'z-web-client')

  for (let index = 1; index <= 101; index += 1) {
    const repoName = `archived-service-${String(index).padStart(3, '0')}`
    // Why: the scan only needs repo markers here; a real git init for 101
    // throwaway repos makes this regression much slower without adding signal.
    mkdirSync(path.join(archivePath, repoName, '.git'), { recursive: true })
  }
  initializeGitRepo(webClientPath)

  return {
    parentPath,
    webClientPath,
    groupName: path.basename(parentPath)
  }
}

async function createCancellableScanFixture(): Promise<{
  parentPath: string
  apiPath: string
  webPath: string
  groupName: string
}> {
  const parentPath = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-cancellable-scan-'))
  tempRoots.push(parentPath)
  const apiPath = path.join(parentPath, 'api')
  const webPath = path.join(parentPath, 'web')

  initializeGitRepo(apiPath)
  initializeGitRepo(webPath)

  return {
    parentPath,
    apiPath,
    webPath,
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

async function installCancellableNestedScanMock(
  electronApp: ElectronApplication,
  scan: {
    selectedPath: string
    selectedPathKind: 'non_git_folder'
    repos: { path: string; displayName: string; depth: number }[]
    truncated: boolean
    timedOut: boolean
    stopped: boolean
    durationMs: number
    maxDepth: number
    maxRepos: number
    timeoutMs: number | null
  }
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, mockedScan) => {
    const pendingScans = new Map<string, () => void>()
    ipcMain.removeHandler('projectGroups:scanNested')
    ipcMain.removeHandler('projectGroups:cancelNestedScan')
    ipcMain.handle('projectGroups:scanNested', async (event, rawArgs: unknown) => {
      const args = rawArgs as { scanId?: string }
      const scanId = args.scanId ?? 'missing-scan-id'
      return await new Promise((resolve) => {
        pendingScans.set(scanId, () =>
          resolve({
            ...mockedScan,
            stopped: true,
            durationMs: mockedScan.durationMs + 1
          })
        )
        event.sender.send('projectGroups:scanNestedProgress', {
          scanId,
          scan: { ...mockedScan, stopped: false }
        })
      })
    })
    ipcMain.handle('projectGroups:cancelNestedScan', (_event, rawArgs: unknown) => {
      const args = rawArgs as { scanId?: string }
      const scanId = args.scanId ?? ''
      const resolveScan = pendingScans.get(scanId)
      if (!resolveScan) {
        return false
      }
      pendingScans.delete(scanId)
      resolveScan()
      return true
    })
  }, scan)
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

  await orcaPage
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /Browse folder/i }).click()

  const importDialog = orcaPage.getByRole('dialog', { name: /Import as project group/i })
  await expect(importDialog.getByText('Found 100 git repositories in this folder.')).toBeVisible()
  await expect(importDialog.getByText('Showing partial scan results.')).toBeVisible()
  await expect(importDialog.getByText('z-web-client', { exact: true }).first()).toBeVisible()

  await importDialog.getByLabel('Deselect all').click()
  await importDialog
    .locator('label')
    .filter({ hasText: 'z-web-client' })
    .locator('input[type="checkbox"]')
    .check()
  await importDialog.getByRole('button', { name: /Import as project group/i }).click()

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

test('can stop a nested repo scan and import repositories found so far', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const fixture = await createCancellableScanFixture()
  await installCancellableNestedScanMock(electronApp, {
    selectedPath: fixture.parentPath,
    selectedPathKind: 'non_git_folder',
    repos: [{ path: fixture.apiPath, displayName: 'api', depth: 1 }],
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 25,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null
  })
  await chooseFolderInNativeDialog(electronApp, fixture.parentPath)

  await orcaPage
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
  await dialog.getByRole('button', { name: /Browse folder/i }).click()

  const importDialog = orcaPage.getByRole('dialog', { name: /Import as project group/i })
  await expect(
    importDialog.getByText('Scanning... Found 1 git repository in this folder.')
  ).toBeVisible()
  await expect(
    importDialog.getByRole('button', { name: /Import as project group/i })
  ).toBeDisabled()
  await importDialog.getByRole('button', { name: /Stop scan/i }).click()
  await expect(importDialog.getByText('Scan stopped early.')).toBeVisible()
  await expect(importDialog.getByText('Found 1 git repository in this folder.')).toBeVisible()
  await expect(importDialog.getByRole('button', { name: /Import as project group/i })).toBeEnabled()

  await importDialog.getByRole('button', { name: /Import as project group/i }).click()

  await expect
    .poll(
      () =>
        orcaPage.evaluate((args) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          const group = state.projectGroups.find((entry) => entry.parentPath === args.parentPath)
          const apiRepo = state.repos.find((repo) => repo.path === args.apiPath)
          const webRepo = state.repos.find((repo) => repo.path === args.webPath)
          return {
            groupName: group?.name ?? null,
            importedApiPath: apiRepo?.path ?? null,
            apiInCreatedGroup: group !== undefined && apiRepo?.projectGroupId === group.id,
            importedWebPath: webRepo?.path ?? null
          }
        }, fixture),
      {
        timeout: 20_000,
        message: 'stopped nested scan partial result was not imported'
      }
    )
    .toEqual({
      groupName: fixture.groupName,
      importedApiPath: fixture.apiPath,
      apiInCreatedGroup: true,
      importedWebPath: null
    })
})
