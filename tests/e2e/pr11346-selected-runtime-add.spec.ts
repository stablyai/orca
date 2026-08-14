import { rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../src/shared/project-group-types'
import type { Repo } from '../../src/shared/repo-types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'
import {
  configureIsolatedGitIdentity,
  createProjectFixtures,
  expectRuntimeActivation,
  injectSameIdLocalActivationCollision,
  installFinalActivationGate
} from './pr11346-selected-runtime-identity-oracle'

async function selectRuntimeHost(page: Page, runtimeName: string): Promise<Locator> {
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect(dialog).toBeVisible()
  const hostPicker = dialog.getByRole('combobox')
  if (!(await hostPicker.textContent())?.includes(runtimeName)) {
    await hostPicker.click()
    await page.locator('[cmdk-item]').filter({ hasText: runtimeName }).click()
  }
  await expect(hostPicker).toContainText(runtimeName)
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
  configureIsolatedGitIdentity(await electronApp.evaluate(({ app }) => app.getPath('home')))

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
    await installFinalActivationGate(client.page, fixture.gitPath)
    const gitDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await gitDialog.locator('#server-project-path').fill(fixture.gitPath)
    await gitDialog.getByRole('button', { name: /Add Git Project/i }).click()
    const gitCollision = await injectSameIdLocalActivationCollision(
      client.page,
      fixture.gitPath,
      fixture.localCloneCollisionPath
    )
    await expect(gitDialog).toBeHidden({ timeout: 30_000 })
    measurements.gitAddMs = Date.now() - startedAt

    startedAt = Date.now()
    await installFinalActivationGate(client.page, fixture.folderPath)
    const folderDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await folderDialog.locator('#server-project-path').fill(fixture.folderPath)
    await folderDialog.getByRole('button', { name: /Open as Folder/i }).click()
    const folderCollision = await injectSameIdLocalActivationCollision(
      client.page,
      fixture.folderPath,
      fixture.localCreateCollisionPath
    )
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
        store.getState().setRuntimeEnvironmentStatus(environmentId, {
          status: null,
          checkedAt: Date.now()
        })
        const response = await window.api.runtimeEnvironments.connect({
          selector: environmentId,
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        store.getState().setRuntimeEnvironmentStatus(environmentId, {
          status: response.result,
          checkedAt: Date.now()
        })
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
        if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
          throw new Error('Paired runtime did not recover after reconnect')
        }
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

    const reversedFolderActivation = await client.page.evaluate(
      ({ catalogFolderPath, runtimeEnvironmentId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const hostId = `runtime:${runtimeEnvironmentId}` as const
        const state = store.getState()
        const runtimeFolder = state.folderWorkspaces.find(
          (workspace) =>
            workspace.folderPath === catalogFolderPath && workspace.executionHostId === hostId
        )
        if (!runtimeFolder) {
          throw new Error('Runtime folder unavailable for reversed activation')
        }
        const sameFolders = state.folderWorkspaces
          .filter((workspace) => workspace.id === runtimeFolder.id)
          .toReversed()
        const sameGroups = state.projectGroups
          .filter((group) => group.id === runtimeFolder.projectGroupId)
          .toReversed()
        store.setState({
          folderWorkspaces: [
            ...state.folderWorkspaces.filter((workspace) => workspace.id !== runtimeFolder.id),
            ...sameFolders
          ],
          projectGroups: [
            ...state.projectGroups.filter((group) => group.id !== runtimeFolder.projectGroupId),
            ...sameGroups
          ]
        })
        store.getState().setActiveFolderWorkspace(runtimeFolder.id, hostId)
        const activated = store.getState()
        return {
          activeHostId: activated.activeWorkspaceExecutionHostId,
          activePath: activated.getKnownWorktreeById(`folder:${runtimeFolder.id}`, hostId)?.path,
          sameIdHosts: activated.folderWorkspaces
            .filter((workspace) => workspace.id === runtimeFolder.id)
            .map((workspace) => workspace.executionHostId)
            .sort()
        }
      },
      {
        catalogFolderPath: fixture.catalogFolderPath,
        runtimeEnvironmentId: client.environmentId
      }
    )
    expect(reversedFolderActivation).toEqual({
      activeHostId: `runtime:${client.environmentId}`,
      activePath: fixture.catalogFolderPath,
      sameIdHosts: ['local', `runtime:${client.environmentId}`]
    })

    const collisionReconnect = await client.page.evaluate(
      async ({ catalogFolderPath, environmentId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const runtimeFolder = store
          .getState()
          .folderWorkspaces.find((workspace) => workspace.folderPath === catalogFolderPath)
        if (!runtimeFolder) {
          throw new Error('Runtime folder unavailable before collision reconnect')
        }
        const staleRequests = [
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })
        ]
        await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
        store.getState().setRuntimeEnvironmentStatus(environmentId, {
          status: null,
          checkedAt: Date.now()
        })
        const response = await window.api.runtimeEnvironments.connect({
          selector: environmentId,
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        store.getState().setRuntimeEnvironmentStatus(environmentId, {
          status: response.result,
          checkedAt: Date.now()
        })
        await store.getState().fetchProjectGroups({ runtimeEnvironmentId: environmentId })
        await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })
        await Promise.allSettled(staleRequests)
        if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
          throw new Error('Paired runtime did not recover after collision reconnect')
        }
        store.getState().setActiveFolderWorkspace(runtimeFolder.id, `runtime:${environmentId}`)
        const state = store.getState()
        return {
          activeHostId: state.activeWorkspaceExecutionHostId,
          folderHosts: state.folderWorkspaces
            .filter((workspace) => workspace.id === runtimeFolder.id)
            .map((workspace) => workspace.executionHostId)
            .sort(),
          groupHosts: state.projectGroups
            .filter((group) => group.id === runtimeFolder.projectGroupId)
            .map((group) => group.executionHostId)
            .sort()
        }
      },
      {
        catalogFolderPath: fixture.catalogFolderPath,
        environmentId: client.environmentId
      }
    )
    expect(collisionReconnect).toEqual({
      activeHostId: `runtime:${client.environmentId}`,
      folderHosts: ['local', `runtime:${client.environmentId}`],
      groupHosts: ['local', `runtime:${client.environmentId}`]
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
          executionHostId: `runtime:${client.environmentId}`,
          folderPath: fixture.catalogFolderPath
        })
      ])
    )

    const clientRegistration = await client.page.evaluate(
      ({
        clonedRepoPath,
        createdRepoPath,
        environmentId,
        folderCollisionId,
        folderPath,
        gitCollisionId,
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
          folderSameIdHosts:
            Object.values(state?.worktreesByRepo ?? {})
              .flat()
              .filter((worktree) => worktree.id === folderCollisionId)
              .map((worktree) => worktree.hostId ?? 'local')
              .sort() ?? [],
          folderOwner:
            state?.repos.find((repo) => repo.path === folderPath)?.executionHostId ?? null,
          gitSameIdHosts:
            Object.values(state?.worktreesByRepo ?? {})
              .flat()
              .filter((worktree) => worktree.id === gitCollisionId)
              .map((worktree) => worktree.hostId ?? 'local')
              .sort() ?? [],
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
        folderCollisionId: folderCollision.runtimeWorktreeId,
        folderPath: fixture.folderPath,
        gitCollisionId: gitCollision.runtimeWorktreeId,
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
      folderSameIdHosts: ['local', `runtime:${client.environmentId}`],
      gitOwner: `runtime:${client.environmentId}`,
      gitSameIdHosts: ['local', `runtime:${client.environmentId}`],
      nestedGroupOwner: `runtime:${client.environmentId}`,
      nestedRepoOwners: [`runtime:${client.environmentId}`, `runtime:${client.environmentId}`],
      nestedReposInGroup: true
    })

    const terminalActivation = await client.page.evaluate(
      async ({ environmentId, worktreeId }) => {
        const bridge = (
          window as unknown as {
            __webRuntimeSessionE2E?: {
              createTerminal: (
                args: Record<string, unknown>
              ) => Promise<{ status: string; message?: string }>
            }
          }
        ).__webRuntimeSessionE2E
        const store = window.__store
        if (!bridge || !store) {
          throw new Error('Runtime terminal activation bridge unavailable')
        }
        const outcome = await bridge.createTerminal({ environmentId, worktreeId })
        const state = store.getState()
        return {
          activeHostId: state.activeWorkspaceExecutionHostId,
          activeWorktreeId: state.activeWorktreeId,
          outcome,
          sameIdHosts: Object.values(state.worktreesByRepo)
            .flat()
            .filter((worktree) => worktree.id === worktreeId)
            .map((worktree) => worktree.hostId ?? 'local')
            .sort()
        }
      },
      {
        environmentId: client.environmentId,
        worktreeId: gitCollision.runtimeWorktreeId
      }
    )
    expect(terminalActivation).toEqual({
      activeHostId: `runtime:${client.environmentId}`,
      activeWorktreeId: gitCollision.runtimeWorktreeId,
      outcome: { status: 'created' },
      sameIdHosts: ['local', `runtime:${client.environmentId}`]
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
  test.setTimeout(300_000)
  await runSelectedRuntimeAddJourney(electronApp, orcaPage, testInfo, true)
})

test('keeps every selected-runtime Add Project path in hidden-window desktop parity', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  await runSelectedRuntimeAddJourney(electronApp, orcaPage, testInfo, false)
})
