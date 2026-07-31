import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { AppState } from '../../src/renderer/src/store/types'
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
  localCloneCollisionPath: string
  localCreateCollisionPath: string
  nestedParentPath: string
  nestedRepoPaths: string[]
  reconnectCatalogPath: string
  rootPath: string
}> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-pr11346-headed-')))
  const gitPath = path.join(rootPath, 'remote-git-project')
  const folderPath = path.join(rootPath, 'remote-plain-folder')
  const cloneParentPath = path.join(rootPath, 'remote-clones')
  const createParentPath = path.join(rootPath, 'remote-created-projects')
  const nestedParentPath = path.join(rootPath, 'remote-nested-projects')
  const catalogFolderPath = path.join(nestedParentPath, 'catalog-workspace')
  const reconnectCatalogPath = path.join(rootPath, 'reconnect-catalog')
  const localCloneCollisionPath = path.join(rootPath, 'local-clone-collision')
  const localCreateCollisionPath = path.join(rootPath, 'local-create-collision')
  const nestedRepoPaths = ['nested-api', 'nested-web'].map((name) =>
    path.join(nestedParentPath, name)
  )
  mkdirSync(folderPath)
  mkdirSync(cloneParentPath)
  mkdirSync(createParentPath)
  writeFileSync(path.join(folderPath, 'REMOTE_FOLDER_MARKER.txt'), 'remote-folder-authority\n')
  initializeGitRepo(gitPath, 'REMOTE_GIT_MARKER.md')
  initializeGitRepo(localCloneCollisionPath, 'LOCAL_CLONE_COLLISION.md')
  initializeGitRepo(localCreateCollisionPath, 'LOCAL_CREATE_COLLISION.md')
  nestedRepoPaths.forEach((repoPath) => initializeGitRepo(repoPath, 'NESTED_REMOTE_MARKER.md'))
  mkdirSync(catalogFolderPath)
  mkdirSync(reconnectCatalogPath)
  return {
    catalogFolderPath,
    cloneParentPath,
    clonedRepoPath: path.join(cloneParentPath, path.basename(gitPath)),
    createParentPath,
    createdRepoPath: path.join(createParentPath, 'runtime-created-project'),
    folderPath,
    gitPath,
    localCloneCollisionPath,
    localCreateCollisionPath,
    nestedParentPath,
    nestedRepoPaths,
    reconnectCatalogPath,
    rootPath
  }
}

type ActivationCollision = {
  localWorktreeId: string
  runtimeWorktreeId: string
}

async function installFinalActivationGate(page: Page, targetPath: string): Promise<void> {
  await page.evaluate((pathToGate) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const originalFetchWorktrees = store.getState().fetchWorktrees
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const gateWindow = window as typeof window & {
      __pr11346ActivationGate?: {
        originalFetchWorktrees: typeof originalFetchWorktrees
        release: () => void
        waiting: boolean
      }
    }
    gateWindow.__pr11346ActivationGate = {
      originalFetchWorktrees,
      release,
      waiting: false
    }
    store.setState({
      fetchWorktrees: async (...args: Parameters<typeof originalFetchWorktrees>) => {
        const result = await originalFetchWorktrees(...args)
        const targetRepo = store
          .getState()
          .repos.find(
            (repo) =>
              repo.path === pathToGate && repo.executionHostId?.startsWith('runtime:') === true
          )
        if (targetRepo?.id === args[0]) {
          gateWindow.__pr11346ActivationGate!.waiting = true
          await released
        }
        return result
      }
    })
  }, targetPath)
}

async function injectSameIdLocalActivationCollision(
  page: Page,
  targetPath: string,
  localPath: string
): Promise<ActivationCollision> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __pr11346ActivationGate?: { waiting: boolean }
            }
          ).__pr11346ActivationGate?.waiting ?? false
      )
    )
    .toBe(true)

  return page.evaluate(
    ({ localCollisionPath, runtimePath }) => {
      const store = window.__store
      const gateWindow = window as typeof window & {
        __pr11346ActivationGate?: {
          originalFetchWorktrees: AppState['fetchWorktrees']
          release: () => void
        }
      }
      const gate = gateWindow.__pr11346ActivationGate
      if (!store || !gate) {
        throw new Error('Activation gate unavailable')
      }
      const state = store.getState()
      const runtimeRepo = state.repos.find(
        (repo) => repo.path === runtimePath && repo.executionHostId?.startsWith('runtime:') === true
      )
      if (!runtimeRepo) {
        throw new Error(`Runtime repo unavailable for ${runtimePath}`)
      }
      const runtimeWorktree = state.worktreesByRepo[runtimeRepo.id]?.find(
        (worktree) => worktree.hostId === runtimeRepo.executionHostId && worktree.isMainWorktree
      )
      if (!runtimeWorktree) {
        throw new Error(`Runtime default checkout unavailable for ${runtimePath}`)
      }
      const localWorktree = {
        ...runtimeWorktree,
        id: `${runtimeRepo.id}::${localCollisionPath}`,
        path: localCollisionPath,
        hostId: 'local' as const,
        runtimeOwnerEnvironmentId: null
      }
      store.setState({
        repos: [
          {
            ...runtimeRepo,
            path: localCollisionPath,
            displayName: `Local collision for ${runtimeRepo.displayName}`,
            executionHostId: 'local',
            connectionId: null
          },
          ...state.repos
        ],
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [runtimeRepo.id]: [localWorktree, ...(state.worktreesByRepo[runtimeRepo.id] ?? [])]
        },
        fetchWorktrees: gate.originalFetchWorktrees
      })
      gate.release()
      delete gateWindow.__pr11346ActivationGate
      return {
        localWorktreeId: localWorktree.id,
        runtimeWorktreeId: runtimeWorktree.id
      }
    },
    { localCollisionPath: localPath, runtimePath: targetPath }
  )
}

async function expectRuntimeActivation(page: Page, collision: ActivationCollision): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        return {
          activeWorktreeId: state?.activeWorktreeId ?? null,
          activeWorktreeHost:
            Object.values(state?.worktreesByRepo ?? {})
              .flat()
              .find((worktree) => worktree.id === state?.activeWorktreeId)?.hostId ?? null
        }
      })
    )
    .toEqual({
      activeWorktreeHost: expect.stringMatching(/^runtime:/),
      activeWorktreeId: collision.runtimeWorktreeId
    })
  expect(collision.runtimeWorktreeId).not.toBe(collision.localWorktreeId)
}

async function selectRuntimeHost(page: Page, runtimeName: string): Promise<Locator> {
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').click()
  await page.locator('[cmdk-item]').filter({ hasText: runtimeName }).click()
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
    await installFinalActivationGate(client.page, fixture.clonedRepoPath)
    const cloneDialog = await selectRuntimeHost(client.page, runtimeName)
    await cloneDialog.getByRole('button', { name: /Clone from URL/i }).click()
    const cloneStep = client.page.getByRole('dialog', { name: /Clone from URL/i })
    await cloneStep.getByRole('textbox').nth(0).fill(fixture.gitPath)
    await cloneStep.getByRole('textbox').nth(1).fill(fixture.cloneParentPath)
    await cloneStep.getByRole('button', { name: /^Clone$/i }).click()
    const cloneCollision = await injectSameIdLocalActivationCollision(
      client.page,
      fixture.clonedRepoPath,
      fixture.localCloneCollisionPath
    )
    await expect(cloneStep).toBeHidden({ timeout: 30_000 })
    await expectRuntimeActivation(client.page, cloneCollision)
    measurements.cloneMs = Date.now() - startedAt

    startedAt = Date.now()
    await installFinalActivationGate(client.page, fixture.createdRepoPath)
    const createDialog = await selectRuntimeHost(client.page, runtimeName)
    await createDialog.getByRole('button', { name: /Create (?:on host|new project)/i }).click()
    const createStep = client.page.getByRole('dialog', { name: /Create a new project/i })
    await createStep.locator('#create-project-name').fill('runtime-created-project')
    await createStep.getByPlaceholder('/home/user/projects').fill(fixture.createParentPath)
    await createStep.getByRole('button', { name: 'Create project', exact: true }).click()
    const createCollision = await injectSameIdLocalActivationCollision(
      client.page,
      fixture.createdRepoPath,
      fixture.localCreateCollisionPath
    )
    await expect(createStep).toBeHidden({ timeout: 30_000 })
    await expectRuntimeActivation(client.page, createCollision)
    measurements.createMs = Date.now() - startedAt

    startedAt = Date.now()
    const reconnectCatalog = await client.page.evaluate(
      async ({ environmentId, reconnectCatalogPath }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const oldRequests = [
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })
        ]
        await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
        const response = await window.api.runtimeEnvironments.connect({
          selector: environmentId,
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
          throw new Error('Paired runtime did not recover after reconnect')
        }
        const groupResponse = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'projectGroup.create',
          params: {
            name: 'Reconnect catalog',
            parentPath: reconnectCatalogPath,
            createdFrom: 'manual'
          },
          timeoutMs: 15_000
        })
        if (!groupResponse.ok) {
          throw new Error(groupResponse.error.message)
        }
        const group = (groupResponse.result as { group: ProjectGroup }).group
        const folderResponse = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'folderWorkspace.create',
          params: {
            folderPath: reconnectCatalogPath,
            name: 'Reconnect catalog workspace',
            projectGroupId: group.id
          },
          timeoutMs: 15_000
        })
        if (!folderResponse.ok) {
          throw new Error(folderResponse.error.message)
        }
        await store.getState().fetchProjectGroups({ runtimeEnvironmentId: environmentId })
        await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })
        await Promise.allSettled(oldRequests)
        return {
          folder: store
            .getState()
            .folderWorkspaces.find((workspace) => workspace.folderPath === reconnectCatalogPath),
          group: store
            .getState()
            .projectGroups.find((entry) => entry.parentPath === reconnectCatalogPath)
        }
      },
      {
        environmentId: client.environmentId,
        reconnectCatalogPath: fixture.reconnectCatalogPath
      }
    )
    expect(reconnectCatalog).toEqual({
      folder: expect.objectContaining({
        executionHostId: `runtime:${client.environmentId}`,
        folderPath: fixture.reconnectCatalogPath
      }),
      group: expect.objectContaining({
        executionHostId: `runtime:${client.environmentId}`,
        parentPath: fixture.reconnectCatalogPath
      })
    })
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

    const sameIdCatalog = await client.page.evaluate(
      async ({
        catalogFolderPath,
        localGroupPath,
        localWorkspacePath,
        nestedParentPath,
        runtimeEnvironmentId
      }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        await store.getState().fetchProjectGroups({ runtimeEnvironmentId })
        await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId })
        const state = store.getState()
        const runtimeGroup = state.projectGroups.find(
          (group) =>
            group.parentPath === nestedParentPath &&
            group.executionHostId === `runtime:${runtimeEnvironmentId}`
        )
        const runtimeFolder = state.folderWorkspaces.find(
          (workspace) =>
            workspace.folderPath === catalogFolderPath &&
            workspace.executionHostId === `runtime:${runtimeEnvironmentId}`
        )
        if (!runtimeGroup || !runtimeFolder) {
          throw new Error('Runtime catalog unavailable for same-ID collision')
        }
        const localGroup = {
          ...runtimeGroup,
          name: 'Local same-ID group',
          parentPath: localGroupPath,
          executionHostId: 'local' as const
        }
        const localFolder = {
          ...runtimeFolder,
          name: 'Local same-ID folder',
          folderPath: localWorkspacePath,
          executionHostId: 'local' as const
        }
        store.setState({
          projectGroups: [localGroup, ...state.projectGroups],
          folderWorkspaces: [localFolder, ...state.folderWorkspaces]
        })
        await store.getState().fetchProjectGroups({ runtimeEnvironmentId })
        await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId })
        const collided = store.getState()
        const result = {
          folders: collided.folderWorkspaces
            .filter((workspace) => workspace.id === runtimeFolder.id)
            .map((workspace) => ({
              executionHostId: workspace.executionHostId,
              folderPath: workspace.folderPath
            })),
          groups: collided.projectGroups
            .filter((group) => group.id === runtimeGroup.id)
            .map((group) => ({
              executionHostId: group.executionHostId,
              parentPath: group.parentPath
            }))
        }
        store.setState({
          projectGroups: collided.projectGroups.filter(
            (group) =>
              !(
                group.id === runtimeGroup.id &&
                group.executionHostId === 'local' &&
                group.parentPath === localGroup.parentPath
              )
          ),
          folderWorkspaces: collided.folderWorkspaces.filter(
            (workspace) =>
              !(
                workspace.id === runtimeFolder.id &&
                workspace.executionHostId === 'local' &&
                workspace.folderPath === localFolder.folderPath
              )
          )
        })
        return result
      },
      {
        catalogFolderPath: fixture.catalogFolderPath,
        localGroupPath: fixture.localCloneCollisionPath,
        localWorkspacePath: fixture.localCreateCollisionPath,
        nestedParentPath: fixture.nestedParentPath,
        runtimeEnvironmentId: client.environmentId
      }
    )
    expect(sameIdCatalog).toEqual({
      folders: expect.arrayContaining([
        {
          executionHostId: 'local',
          folderPath: fixture.localCreateCollisionPath
        },
        {
          executionHostId: `runtime:${client.environmentId}`,
          folderPath: fixture.catalogFolderPath
        }
      ]),
      groups: expect.arrayContaining([
        {
          executionHostId: 'local',
          parentPath: fixture.localCloneCollisionPath
        },
        {
          executionHostId: `runtime:${client.environmentId}`,
          parentPath: fixture.nestedParentPath
        }
      ])
    })

    const catalogAfterLocalRefresh = await client.page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      await store.getState().fetchProjectGroups()
      await store.getState().fetchFolderWorkspaces()
      return {
        folderWorkspaces: store.getState().folderWorkspaces,
        projectGroups: store.getState().projectGroups
      }
    })
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
      // Why: duplicate checkout names are disambiguated with a parent path.
      await expect(client.page.getByText(projectName, { exact: false }).first()).toBeVisible()
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
