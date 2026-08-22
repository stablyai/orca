import { mkdirSync } from 'node:fs'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../src/shared/project-group-types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'
import { expectFolderWorkspaceSidebarGrouping } from './sta-4964-folder-sidebar-oracle'

test('keeps a runtime-owned folder under its paired host in every grouping mode @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'STA-4964 runtime', {
    headful: true
  })
  const runtimeHostId = `runtime:${client.environmentId}` as const
  const runtimeFolderPath = testInfo.outputPath('runtime-folder')
  const localFolderPath = testInfo.outputPath('local-collision-folder')
  mkdirSync(runtimeFolderPath, { recursive: true })
  mkdirSync(localFolderPath, { recursive: true })

  try {
    expect(
      await client.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isVisible()
      )
    ).toBe(true)
    await expect.poll(() => client.page.evaluate(() => window.__store != null)).toBe(true)
    const seeded = await client.page.evaluate(
      async (args) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        await store.getState().setActiveRuntimeEnvironmentPreference(null)
        const groupResponse = await window.api.runtimeEnvironments.call({
          selector: args.environmentId,
          method: 'projectGroup.create',
          params: {
            name: 'Runtime-owned group',
            parentPath: args.runtimeFolderPath,
            createdFrom: 'manual'
          },
          timeoutMs: 15_000
        })
        if (!groupResponse.ok) {
          throw new Error(groupResponse.error.message)
        }
        const createdGroup = (groupResponse.result as { group: ProjectGroup }).group
        const folderResponse = await window.api.runtimeEnvironments.call({
          selector: args.environmentId,
          method: 'folderWorkspace.create',
          params: {
            folderPath: args.runtimeFolderPath,
            name: 'Runtime-owned folder',
            projectGroupId: createdGroup.id
          },
          timeoutMs: 15_000
        })
        if (!folderResponse.ok) {
          throw new Error(folderResponse.error.message)
        }
        const createdFolder = (folderResponse.result as { folderWorkspace: FolderWorkspace })
          .folderWorkspace
        const createdLocalGroup = await window.api.projectGroups.create({
          name: 'Local same-ID collision',
          parentPath: args.localFolderPath
        })
        const createdLocalFolder = await window.api.folderWorkspaces.create({
          folderPath: args.localFolderPath,
          name: 'Local same-ID collision',
          projectGroupId: createdLocalGroup.id
        })
        await store.getState().fetchProjectGroups()
        await store.getState().fetchFolderWorkspaces()
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        const state = store.getState()
        const runtimeFolder = state.folderWorkspaces.find(
          (workspace) =>
            workspace.id === createdFolder.id && workspace.executionHostId === args.runtimeHostId
        )
        const runtimeGroup = state.projectGroups.find(
          (group) => group.id === createdGroup.id && group.executionHostId === args.runtimeHostId
        )
        const localFolder = state.folderWorkspaces.find(
          (workspace) =>
            workspace.id === createdLocalFolder.id && workspace.executionHostId === 'local'
        )
        const localGroup = state.projectGroups.find(
          (group) => group.id === createdLocalGroup.id && group.executionHostId === 'local'
        )
        if (!runtimeFolder || !runtimeGroup || !localFolder || !localGroup) {
          throw new Error('Local/runtime folder catalogs unavailable')
        }
        // Fault injection is limited to the claimed collision: both records otherwise came
        // through their real local/runtime catalogs and owner-stamping paths.
        store.setState({
          folderWorkspaces: [
            {
              ...localFolder,
              id: runtimeFolder.id,
              projectGroupId: runtimeGroup.id
            },
            ...state.folderWorkspaces.filter((workspace) => workspace.id !== localFolder.id)
          ],
          projectGroups: [
            {
              ...localGroup,
              id: runtimeGroup.id
            },
            ...state.projectGroups.filter((group) => group.id !== localGroup.id)
          ],
          workspaceHostScope: 'all',
          activeWorkspaceExecutionHostId: 'local'
        })
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        const hydrated = store.getState()
        return {
          folders: hydrated.folderWorkspaces
            .filter((workspace) => workspace.id === createdFolder.id)
            .map((workspace) => ({
              id: workspace.id,
              executionHostId: workspace.executionHostId
            })),
          groups: hydrated.projectGroups
            .filter((group) => group.id === createdGroup.id)
            .map((group) => ({ id: group.id, executionHostId: group.executionHostId }))
        }
      },
      {
        environmentId: client.environmentId,
        localFolderPath,
        runtimeFolderPath,
        runtimeHostId
      }
    )
    expect(new Set(seeded.folders.map((workspace) => workspace.id)).size).toBe(1)
    expect(seeded.folders.map((workspace) => workspace.executionHostId)).toEqual([
      'local',
      runtimeHostId
    ])
    expect(new Set(seeded.groups.map((group) => group.id)).size).toBe(1)
    expect(seeded.groups.map((group) => group.executionHostId)).toEqual(['local', runtimeHostId])

    const disconnected = await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      const result = await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      const reachable = await store.getState().refreshRuntimeEnvironmentStatus(environmentId, 1_000)
      return {
        disconnectedId: result.disconnected.id,
        reachable,
        status: store.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status ?? null
      }
    }, client.environmentId)
    expect(disconnected).toEqual({
      disconnectedId: client.environmentId,
      reachable: false,
      status: null
    })
    await expectFolderWorkspaceSidebarGrouping(client.page, testInfo, {
      folderPath: runtimeFolderPath,
      hostId: runtimeHostId,
      localFolderPath,
      screenshotPrefix: 'disconnected'
    })

    const reconnected = await client.page.evaluate(
      async (args) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const response = await window.api.runtimeEnvironments.connect({
          selector: args.environmentId,
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        store.getState().setRuntimeEnvironmentStatus(args.environmentId, {
          status: response.result,
          checkedAt: Date.now()
        })
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        const hydrated = store.getState()
        return {
          folders: hydrated.folderWorkspaces
            .filter(
              (workspace) =>
                workspace.folderPath === args.runtimeFolderPath ||
                workspace.folderPath === args.localFolderPath
            )
            .map((workspace) => workspace.executionHostId)
            .sort((left, right) => String(left).localeCompare(String(right))),
          groups: hydrated.projectGroups
            .filter((group) => group.id === args.groupId)
            .map((group) => group.executionHostId)
            .sort((left, right) => String(left).localeCompare(String(right)))
        }
      },
      {
        environmentId: client.environmentId,
        groupId: seeded.groups[0]!.id,
        localFolderPath,
        runtimeFolderPath
      }
    )
    expect(reconnected).toEqual({
      folders: ['local', runtimeHostId],
      groups: ['local', runtimeHostId]
    })
    await expectFolderWorkspaceSidebarGrouping(client.page, testInfo, {
      folderPath: runtimeFolderPath,
      hostId: runtimeHostId,
      localFolderPath,
      screenshotPrefix: 'reconnected'
    })
  } finally {
    await client.dispose()
  }
})
