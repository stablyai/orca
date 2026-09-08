import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentCall = vi.fn()
const folderWorkspacesCreate = vi.fn()
const folderWorkspacesUpdate = vi.fn()
const linkedTask = {
  provider: 'kaneo' as const,
  type: 'issue' as const,
  number: 0,
  title: 'Improve booking confirmation',
  url: 'https://tasks.example.com/dashboard/workspace/workspace-1/project/project-1/task/task-1'
}
const folderWorkspace: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Booking',
  folderPath: '/workspace/booking',
  executionHostId: 'runtime:env-owner',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}

function configureRuntime(missingCapability?: string): void {
  const status = createCompatibleRuntimeStatusResponse('runtime-owner')
  if (status.ok && missingCapability) {
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== missingCapability
    )
  }
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: { create: folderWorkspacesCreate, update: folderWorkspacesUpdate },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
      }
    }
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  folderWorkspacesCreate.mockReset()
  folderWorkspacesUpdate.mockReset()
  configureRuntime()
})

describe.each(['create', 'update'] as const)(
  'Kaneo folder %s capability negotiation',
  (operation) => {
    function performMutation(store: ReturnType<typeof createTestStore>) {
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-focused' } as never,
        folderWorkspaces: [folderWorkspace]
      })
      return operation === 'create'
        ? store
            .getState()
            .createFolderWorkspace(
              { projectGroupId: folderWorkspace.projectGroupId, name: 'Booking', linkedTask },
              { runtimeEnvironmentId: 'env-owner' }
            )
        : store.getState().updateFolderWorkspace(folderWorkspace.id, { linkedTask })
    }

    it.each(['kaneo.task-link.v1', 'worktree.linked-work-item-context.v1'])(
      'refuses a runtime missing %s before sending a mutation',
      async (missingCapability) => {
        configureRuntime(missingCapability)
        const store = createTestStore()

        await expect(performMutation(store)).rejects.toThrow(
          'Update the remote runtime to link Kaneo tasks'
        )

        expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
        expect(folderWorkspacesCreate).not.toHaveBeenCalled()
        expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
        expect(store.getState().folderWorkspaces).toEqual([folderWorkspace])
      }
    )

    it('persists the link on the selected owner when both capabilities are available', async () => {
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'folder-mutation',
        ok: true,
        result: { folderWorkspace: { ...folderWorkspace, linkedTask } },
        _meta: { runtimeId: 'runtime-owner' }
      })
      const store = createTestStore()

      await performMutation(store)

      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-owner',
        method: `folderWorkspace.${operation}`,
        params:
          operation === 'create'
            ? { projectGroupId: folderWorkspace.projectGroupId, name: 'Booking', linkedTask }
            : { folderWorkspaceId: folderWorkspace.id, updates: { linkedTask } },
        timeoutMs: 15_000
      })
      expect(store.getState().folderWorkspaces[0]?.linkedTask).toEqual(linkedTask)
      expect(folderWorkspacesCreate).not.toHaveBeenCalled()
      expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
    })
  }
)

describe('changing an existing Kaneo folder link', () => {
  const kaneoFolder = { ...folderWorkspace, linkedTask }
  const replacement = {
    ...linkedTask,
    provider: 'linear' as const,
    url: 'https://linear.app/example/issue/TEST-1'
  }

  it.each(['kaneo.task-link.v1', 'worktree.linked-work-item-context.v1'])(
    'blocks removal and replacement when the owner lacks %s',
    async (missingCapability) => {
      configureRuntime(missingCapability)
      const store = createTestStore()
      store.setState({ folderWorkspaces: [kaneoFolder] })

      for (const nextLink of [null, replacement]) {
        await expect(
          store.getState().updateFolderWorkspace(kaneoFolder.id, { linkedTask: nextLink })
        ).rejects.toThrow('Update the remote runtime to link Kaneo tasks')
      }

      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(store.getState().folderWorkspaces).toEqual([kaneoFolder])
    }
  )

  it.each([null, replacement])('persists a supported link change: %j', async (nextLink) => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'folder-update',
      ok: true,
      result: { folderWorkspace: { ...kaneoFolder, linkedTask: nextLink } },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({ folderWorkspaces: [kaneoFolder] })

    await expect(
      store.getState().updateFolderWorkspace(kaneoFolder.id, { linkedTask: nextLink })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-owner',
        method: 'folderWorkspace.update',
        params: { folderWorkspaceId: kaneoFolder.id, updates: { linkedTask: nextLink } }
      })
    )
    expect(store.getState().folderWorkspaces[0]?.linkedTask).toEqual(nextLink)
  })

  it('allows unrelated metadata updates without Kaneo support', async () => {
    configureRuntime('kaneo.task-link.v1')
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'folder-update',
      ok: true,
      result: { folderWorkspace: { ...kaneoFolder, name: 'Renamed' } },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({ folderWorkspaces: [kaneoFolder] })

    await expect(
      store.getState().updateFolderWorkspace(kaneoFolder.id, { name: 'Renamed' })
    ).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
  })

  it('does not gate a different owner with the same folder ID', async () => {
    configureRuntime('kaneo.task-link.v1')
    const otherFolder = { ...folderWorkspace, executionHostId: 'runtime:env-other' as const }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'folder-update',
      ok: true,
      result: { folderWorkspace: otherFolder },
      _meta: { runtimeId: 'runtime-other' }
    })
    const store = createTestStore()
    store.setState({ folderWorkspaces: [kaneoFolder, otherFolder] })

    await expect(
      store
        .getState()
        .updateFolderWorkspace(
          otherFolder.id,
          { linkedTask: null },
          { executionHostId: 'runtime:env-other' }
        )
    ).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-other', method: 'folderWorkspace.update' })
    )
    expect(store.getState().folderWorkspaces[0]).toEqual(kaneoFolder)
  })
})
