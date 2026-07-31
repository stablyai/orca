import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../src/shared/types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'

function initializeGitRepo(repoPath: string, markerName: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'pr11346@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'PR 11346 E2E'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  writeFileSync(path.join(repoPath, markerName), `# ${path.basename(repoPath)} authority\n`)
  execFileSync('git', ['add', markerName], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial remote fixture'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
}

async function createProjectFixtures(): Promise<{
  catalogFolderPath: string
  cloneParentPath: string
  clonedRepoPath: string
  createdRepoPath: string
  createParentPath: string
  folderPath: string
  gitPath: string
  nestedParentPath: string
  nestedRepoPaths: string[]
  rootPath: string
}> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-pr11346-headed-')))
  const gitPath = path.join(rootPath, 'remote-git-project')
  const folderPath = path.join(rootPath, 'remote-plain-folder')
  const cloneParentPath = path.join(rootPath, 'remote-clones')
  const createParentPath = path.join(rootPath, 'remote-created-projects')
  const nestedParentPath = path.join(rootPath, 'remote-nested-projects')
  const catalogFolderPath = path.join(nestedParentPath, 'catalog-workspace')
  const nestedRepoPaths = ['nested-api', 'nested-web'].map((name) =>
    path.join(nestedParentPath, name)
  )
  mkdirSync(folderPath)
  mkdirSync(cloneParentPath)
  mkdirSync(createParentPath)
  writeFileSync(path.join(folderPath, 'REMOTE_FOLDER_MARKER.txt'), 'remote-folder-authority\n')
  initializeGitRepo(gitPath, 'REMOTE_GIT_MARKER.md')
  nestedRepoPaths.forEach((repoPath) => initializeGitRepo(repoPath, 'NESTED_REMOTE_MARKER.md'))
  mkdirSync(catalogFolderPath)
  return {
    catalogFolderPath,
    cloneParentPath,
    clonedRepoPath: path.join(cloneParentPath, path.basename(gitPath)),
    createParentPath,
    createdRepoPath: path.join(createParentPath, 'runtime-created-project'),
    folderPath,
    gitPath,
    nestedParentPath,
    nestedRepoPaths,
    rootPath
  }
}

async function selectRuntimeHost(page: Page, runtimeName: string): Promise<Locator> {
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').click()
  await page.getByText(runtimeName, { exact: true }).click()
  await expect(dialog.getByRole('combobox')).toContainText(runtimeName)
  return dialog
}

async function selectRuntimeHostAndOpenManualPath(
  page: Page,
  runtimeName: string
): Promise<Locator> {
  const dialog = await selectRuntimeHost(page, runtimeName)
  await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
  const browseDialog = page.getByRole('dialog', { name: /Browse host filesystem/i })
  await expect(browseDialog).toBeVisible()
  await browseDialog.getByRole('button', { name: /^Cancel$/i }).click()
  const manualDialog = page.getByRole('dialog', { name: /Open host project/i })
  await expect(manualDialog.locator('#server-project-path')).toBeVisible()
  return manualDialog
}

async function listRuntimeInventory(client: RuntimeClient): Promise<{
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
  repos: Repo[]
}> {
  const [repoResult, folderResult, projectGroupResult] = await Promise.all([
    client.call<{ repos: Repo[] }>('repo.list'),
    client.call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list'),
    client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
  ])
  return {
    repos: repoResult.result.repos,
    folderWorkspaces: folderResult.result.folderWorkspaces,
    projectGroups: projectGroupResult.result.groups
  }
}

async function setActiveRuntimePreference(page: Page, environmentId: string | null): Promise<void> {
  const selected = await page.evaluate(async (nextEnvironmentId) => {
    const next = await window.api.settings.setActiveRuntimeEnvironmentPreference({
      environmentId: nextEnvironmentId
    })
    window.__store?.setState({ settings: next })
    return next.activeRuntimeEnvironmentId
  }, environmentId)
  expect(selected).toBe(environmentId)
}

async function runSelectedRuntimeAddJourney(
  electronApp: ElectronApplication,
  orcaPage: Page,
  testInfo: TestInfo,
  visible: boolean
): Promise<void> {
  const runtimeName = `PR 11346 ${visible ? 'headed' : 'hidden-window'} runtime`
  const fixture = await createProjectFixtures()
  await waitForSessionReady(orcaPage)
  const serverVisible = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible())
  )
  expect(serverVisible).toBe(visible)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, runtimeName)
  const serverUserDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const clientUserDataDir = await client.app.evaluate(({ app }) => app.getPath('userData'))
  const serverRuntime = new RuntimeClient(serverUserDataDir)
  const clientLocalRuntime = new RuntimeClient(clientUserDataDir)

  try {
    const measurements: Record<string, number> = {}
    if (visible) {
      await client.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.show()
      })
      expect(
        await client.app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
        )
      ).toBe(true)
    }
    let startedAt = Date.now()
    await setActiveRuntimePreference(client.page, null)
    await setActiveRuntimePreference(client.page, client.environmentId)
    await setActiveRuntimePreference(client.page, null)
    measurements.runtimeSwitchMs = Date.now() - startedAt

    const initialServerInventory = await listRuntimeInventory(serverRuntime)
    const initialClientInventory = await listRuntimeInventory(clientLocalRuntime)
    expect(initialServerInventory.repos.map((repo) => repo.path)).not.toContain(fixture.gitPath)
    expect(initialClientInventory.repos.map((repo) => repo.path)).not.toContain(fixture.gitPath)

    startedAt = Date.now()
    const gitDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await gitDialog.locator('#server-project-path').fill(fixture.gitPath)
    await gitDialog.getByRole('button', { name: /Add Git Project/i }).click()
    await expect(gitDialog).toBeHidden({ timeout: 30_000 })
    measurements.gitAddMs = Date.now() - startedAt

    startedAt = Date.now()
    const folderDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await folderDialog.locator('#server-project-path').fill(fixture.folderPath)
    await folderDialog.getByRole('button', { name: /Open as Folder/i }).click()
    await expect(folderDialog).toBeHidden({ timeout: 30_000 })
    measurements.folderAddMs = Date.now() - startedAt

    startedAt = Date.now()
    const cloneDialog = await selectRuntimeHost(client.page, runtimeName)
    await cloneDialog.getByRole('button', { name: /Clone from URL/i }).click()
    const cloneStep = client.page.getByRole('dialog', { name: /Clone from URL/i })
    await cloneStep.getByRole('textbox').nth(0).fill(fixture.gitPath)
    await cloneStep.getByRole('textbox').nth(1).fill(fixture.cloneParentPath)
    await cloneStep.getByRole('button', { name: /^Clone$/i }).click()
    await expect(cloneStep).toBeHidden({ timeout: 30_000 })
    measurements.cloneMs = Date.now() - startedAt

    startedAt = Date.now()
    const createDialog = await selectRuntimeHost(client.page, runtimeName)
    await createDialog.getByRole('button', { name: /Create (?:on host|new project)/i }).click()
    const createStep = client.page.getByRole('dialog', { name: /Create a new project/i })
    await createStep.locator('#create-project-name').fill('runtime-created-project')
    await createStep.getByPlaceholder('/home/user/projects').fill(fixture.createParentPath)
    await createStep.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(createStep).toBeHidden({ timeout: 30_000 })
    measurements.createMs = Date.now() - startedAt

    startedAt = Date.now()
    await client.page.evaluate(async (environmentId) => {
      await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      const response = await window.api.runtimeEnvironments.connect({
        selector: environmentId,
        timeoutMs: 15_000
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const store = window.__store
      if (!store || !(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
        throw new Error('Paired runtime did not recover after reconnect')
      }
    }, client.environmentId)
    await setActiveRuntimePreference(client.page, client.environmentId)
    await setActiveRuntimePreference(client.page, null)
    measurements.reconnectMs = Date.now() - startedAt

    startedAt = Date.now()
    const nestedDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await nestedDialog.locator('#server-project-path').fill(fixture.nestedParentPath)
    await nestedDialog.getByRole('button', { name: /Add Git Project/i }).click()
    const importDialog = client.page.getByRole('dialog', {
      name: /Import repositories from folder/i
    })
    await expect(importDialog.getByText('nested-api', { exact: true }).first()).toBeVisible({
      timeout: 30_000
    })
    await expect(importDialog.getByText('nested-web', { exact: true }).first()).toBeVisible()
    await importDialog.getByRole('button', { name: 'Yes, import as group', exact: true }).click()
    await expect(importDialog).toBeHidden({ timeout: 30_000 })
    measurements.nestedImportMs = Date.now() - startedAt

    const remoteBrowse = await client.page.evaluate(
      async ({ environmentId, rootPath }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.browseServerDir',
          params: { path: rootPath },
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result as { entries: { name: string; isDirectory: boolean }[] }
      },
      { environmentId: client.environmentId, rootPath: fixture.rootPath }
    )
    expect(remoteBrowse.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: path.basename(fixture.gitPath), isDirectory: true }),
        expect.objectContaining({ name: path.basename(fixture.folderPath), isDirectory: true }),
        expect.objectContaining({
          name: path.basename(fixture.nestedParentPath),
          isDirectory: true
        })
      ])
    )

    await expect
      .poll(async () => {
        const inventory = await listRuntimeInventory(serverRuntime)
        return {
          groupParentPaths: inventory.projectGroups.map((group) => group.parentPath),
          repoPaths: inventory.repos.map((repo) => repo.path)
        }
      })
      .toEqual({
        groupParentPaths: expect.arrayContaining([fixture.nestedParentPath]),
        repoPaths: expect.arrayContaining([
          fixture.gitPath,
          fixture.folderPath,
          fixture.clonedRepoPath,
          fixture.createdRepoPath,
          ...fixture.nestedRepoPaths
        ])
      })

    const runtimeCatalog = await listRuntimeInventory(serverRuntime)
    const runtimeGroup = runtimeCatalog.projectGroups.find(
      (group) => group.parentPath === fixture.nestedParentPath
    )
    if (!runtimeGroup) {
      throw new Error('Runtime project group unavailable for folder catalog boundary')
    }
    await serverRuntime.call('folderWorkspace.create', {
      folderPath: fixture.catalogFolderPath,
      name: 'Runtime catalog workspace',
      projectGroupId: runtimeGroup.id
    })
    expect(
      (await listRuntimeInventory(serverRuntime)).folderWorkspaces.map(
        (workspace) => workspace.folderPath
      )
    ).toContain(fixture.catalogFolderPath)

    const catalogAfterLocalRefresh = await client.page.evaluate(async (runtimeEnvironmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      await store.getState().fetchProjectGroups({ runtimeEnvironmentId })
      await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId })
      await store.getState().fetchProjectGroups()
      await store.getState().fetchFolderWorkspaces()
      return {
        folderWorkspaces: store.getState().folderWorkspaces,
        projectGroups: store.getState().projectGroups
      }
    }, client.environmentId)
    expect(catalogAfterLocalRefresh.projectGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionHostId: `runtime:${client.environmentId}`,
          parentPath: fixture.nestedParentPath
        })
      ])
    )
    expect(catalogAfterLocalRefresh.folderWorkspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folderPath: fixture.catalogFolderPath
        })
      ])
    )

    const clientRegistration = await client.page.evaluate(
      ({
        clonedRepoPath,
        createdRepoPath,
        environmentId,
        folderPath,
        gitPath,
        nestedParentPath,
        nestedRepoPaths
      }) => {
        const state = window.__store?.getState()
        const nestedGroup = state?.projectGroups.find(
          (group) => group.parentPath === nestedParentPath
        )
        const nestedRepos = state?.repos.filter((repo) => nestedRepoPaths.includes(repo.path)) ?? []
        return {
          clonedOwner:
            state?.repos.find((repo) => repo.path === clonedRepoPath)?.executionHostId ?? null,
          createdOwner:
            state?.repos.find((repo) => repo.path === createdRepoPath)?.executionHostId ?? null,
          folderKind: state?.repos.find((repo) => repo.path === folderPath)?.kind ?? null,
          folderOwner:
            state?.repos.find((repo) => repo.path === folderPath)?.executionHostId ?? null,
          gitOwner: state?.repos.find((repo) => repo.path === gitPath)?.executionHostId ?? null,
          nestedGroupOwner: nestedGroup?.executionHostId ?? null,
          nestedRepoOwners: nestedRepos.map((repo) => repo.executionHostId ?? null).sort(),
          nestedReposInGroup:
            nestedGroup !== undefined &&
            nestedRepos.length === nestedRepoPaths.length &&
            nestedRepos.every((repo) => repo.projectGroupId === nestedGroup.id),
          activeRuntimeEnvironmentId: state?.settings?.activeRuntimeEnvironmentId ?? null,
          expectedOwner: `runtime:${environmentId}`
        }
      },
      {
        clonedRepoPath: fixture.clonedRepoPath,
        createdRepoPath: fixture.createdRepoPath,
        environmentId: client.environmentId,
        folderPath: fixture.folderPath,
        gitPath: fixture.gitPath,
        nestedParentPath: fixture.nestedParentPath,
        nestedRepoPaths: fixture.nestedRepoPaths
      }
    )
    expect(clientRegistration).toEqual({
      activeRuntimeEnvironmentId: null,
      clonedOwner: `runtime:${client.environmentId}`,
      createdOwner: `runtime:${client.environmentId}`,
      expectedOwner: `runtime:${client.environmentId}`,
      folderKind: 'folder',
      folderOwner: `runtime:${client.environmentId}`,
      gitOwner: `runtime:${client.environmentId}`,
      nestedGroupOwner: `runtime:${client.environmentId}`,
      nestedRepoOwners: [`runtime:${client.environmentId}`, `runtime:${client.environmentId}`],
      nestedReposInGroup: true
    })

    const finalClientInventory = await listRuntimeInventory(clientLocalRuntime)
    expect(finalClientInventory.repos.map((repo) => repo.path)).toEqual(
      expect.not.arrayContaining([
        fixture.gitPath,
        fixture.folderPath,
        fixture.clonedRepoPath,
        fixture.createdRepoPath
      ])
    )
    expect(finalClientInventory.repos.map((repo) => repo.path)).toEqual(
      expect.not.arrayContaining(fixture.nestedRepoPaths)
    )
    expect(finalClientInventory.projectGroups.map((group) => group.parentPath)).not.toContain(
      fixture.nestedParentPath
    )
    expect(
      finalClientInventory.folderWorkspaces.map((workspace) => workspace.folderPath)
    ).not.toContain(fixture.catalogFolderPath)
    for (const projectName of [
      path.basename(fixture.gitPath),
      path.basename(fixture.folderPath),
      path.basename(fixture.clonedRepoPath),
      path.basename(fixture.createdRepoPath),
      ...fixture.nestedRepoPaths.map((repoPath) => path.basename(repoPath))
    ]) {
      await expect(client.page.getByText(projectName, { exact: true }).first()).toBeVisible()
    }
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
    console.info(`[pr11346-routing] ${JSON.stringify({ topology: runtimeName, ...measurements })}`)
    await client.page.screenshot({
      path: testInfo.outputPath(`${visible ? 'headed' : 'hidden-window'}-selected-runtime-add.png`),
      fullPage: true
    })
  } finally {
    await client.dispose()
    rmSync(fixture.rootPath, { recursive: true, force: true })
  }
}

test('routes every Add Project path to a selected non-default headed runtime @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await runSelectedRuntimeAddJourney(electronApp, orcaPage, testInfo, true)
})

test('keeps every selected-runtime Add Project path in hidden-window desktop parity', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await runSelectedRuntimeAddJourney(electronApp, orcaPage, testInfo, false)
})
