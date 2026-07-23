import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from './file-explorer-operation-owner'

const initialState = useAppStore.getInitialState()
const worktreeId = 'repo-1::/srv/project'

function worktree(hostId: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  return {
    id: worktreeId,
    repoId: 'repo-1',
    path: '/srv/project',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

afterEach(() => {
  useAppStore.getState().setRuntimeEnvironments([])
  useAppStore.setState(initialState, true)
})

describe('file explorer operation generations', () => {
  it('invalidates a nested SSH mutation when that target reconnects', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { 'repo-1': [worktree('ssh:private-target', 'hub-a')] }
    })
    useAppStore.getState().setEnvironmentSshConnectionState('hub-a', 'private-target', {
      targetId: 'private-target',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 1
    })
    const owner = getFileExplorerOperationOwner(worktreeId)
    const guard = captureFileExplorerOperationGuard(worktreeId, owner)

    useAppStore.getState().setEnvironmentSshConnectionState('hub-a', 'private-target', {
      targetId: 'private-target',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 2
    })

    expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns")
  })

  it('invalidates a direct SSH mutation when that target reconnects', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { 'repo-1': [worktree('ssh:client-target')] }
    })
    useAppStore.getState().setSshConnectionState('client-target', {
      targetId: 'client-target',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 1
    })
    const owner = getFileExplorerOperationOwner(worktreeId)
    const guard = captureFileExplorerOperationGuard(worktreeId, owner)

    useAppStore.getState().setSshConnectionState('client-target', {
      targetId: 'client-target',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 2
    })

    expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns")
  })

  it('invalidates a folder-workspace mutation when its SSH target reconnects', () => {
    const folderWorkspaceId = 'folder-1'
    const folderWorktreeId = folderWorkspaceKey(folderWorkspaceId)
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: folderWorkspaceId,
          projectGroupId: 'group-1',
          connectionId: 'client-target'
        } as never
      ],
      projectGroups: [{ id: 'group-1', connectionId: 'client-target' } as never],
      repos: [],
      worktreesByRepo: {}
    })
    useAppStore.getState().setSshConnectionState('client-target', {
      targetId: 'client-target',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 1
    })
    const owner = getFileExplorerOperationOwner(folderWorktreeId)
    const guard = captureFileExplorerOperationGuard(folderWorktreeId, owner)

    useAppStore.getState().setSshConnectionState('client-target', {
      targetId: 'client-target',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 2
    })

    expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns")
  })

  it('invalidates a mutation when the saved HUB points at a replacement runtime', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { 'repo-1': [worktree('local', 'hub-a')] }
    })
    useAppStore.getState().setRuntimeEnvironmentStatus('hub-a', {
      status: { runtimeId: 'runtime-a' } as never,
      checkedAt: 1
    })
    const owner = getFileExplorerOperationOwner(worktreeId)
    const guard = captureFileExplorerOperationGuard(worktreeId, owner)

    useAppStore.getState().setRuntimeEnvironmentStatus('hub-a', {
      status: { runtimeId: 'runtime-b' } as never,
      checkedAt: 2
    })

    expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns")
  })

  it('fails closed when nested SSH ownership has no authoritative generation', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { 'repo-1': [worktree('ssh:private-target', 'hub-a')] }
    })
    const owner = getFileExplorerOperationOwner(worktreeId)

    expect(() => captureFileExplorerOperationGuard(worktreeId, owner)).toThrow(
      "Couldn't determine which host owns"
    )
  })

  it('invalidates a mutation when the same saved HUB id is re-paired', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: { 'repo-1': [worktree('local', 'hub-a')] }
    })
    useAppStore
      .getState()
      .setRuntimeEnvironments([{ id: 'hub-a', createdAt: 1, pairingRevision: 1 } as never])
    const owner = getFileExplorerOperationOwner(worktreeId)
    const guard = captureFileExplorerOperationGuard(worktreeId, owner)

    useAppStore
      .getState()
      .setRuntimeEnvironments([{ id: 'hub-a', createdAt: 1, pairingRevision: 2 } as never])

    expect(() => guard.assertCurrent()).toThrow("Couldn't determine which host owns")
  })
})
