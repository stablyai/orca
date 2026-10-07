import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { captureFolderParentContext } from '@/components/sidebar/folder-workspace-parent-candidates'
import { normalizeLineageResponse } from './worktrees/metadata/worktree-lineage-refresh'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import type * as RuntimeRpcModule from '../../runtime/runtime-rpc-client'
import type { WorktreeWithLineage } from './worktrees/listing/worktree-slice-types'
import { createTestStore } from './worktrees-slice-test-harness'
import {
  makeFolderWorkspace,
  makeLineage,
  makeWorktree,
  makeWorkspaceLineage
} from './worktrees-slice-test-fixtures'
import { FolderParentMutationError } from './worktrees/metadata/worktree-folder-parent-actions'

const rpc = vi.hoisted(() => vi.fn())
const groups = vi.hoisted(() => vi.fn())
const folders = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcModule>()),
  callRuntimeRpc: rpc
}))
vi.mock('../project-groups/project-group-catalog', () => ({
  fetchProjectGroupCatalogForTarget: groups
}))
vi.mock('../folder-workspaces/folder-workspace-catalog', () => ({
  fetchFolderWorkspaceCatalogForTarget: folders
}))

let sequence = 0
function setup(environmentId?: string) {
  const instanceId = `instance-${++sequence}`
  const id = 'repo1::/path/child'
  const identity = createWorktreeIdentity({ worktreeId: id, executionHostId: 'local', instanceId })
  const child = makeWorktree({
    id,
    repoId: 'repo1',
    hostId: environmentId ? `runtime:${environmentId}` : 'local',
    runtimeOwnerEnvironmentId: environmentId,
    instanceId,
    identity
  })
  const store = createTestStore()
  store.setState({
    worktreesByRepo: { repo1: [child] },
    worktreeLineageById: {},
    workspaceLineageByChildKey: {}
  })
  const context = captureFolderParentContext(store.getState(), child)
  if (!context) {
    throw new Error('Expected captured fixture identity')
  }
  const folder = makeFolderWorkspace({
    id: 'folder',
    projectGroupId: 'group',
    executionHostId: environmentId ? `runtime:${environmentId}` : 'local'
  })
  const group = {
    id: 'group',
    name: 'Group',
    parentPath: '/work/platform',
    parentGroupId: null,
    createdFrom: 'manual' as const,
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  const edge = makeWorkspaceLineage({
    childWorkspaceKey: worktreeWorkspaceKey(id),
    childInstanceId: instanceId,
    parentWorkspaceKey: folderWorkspaceKey(folder.id)
  })
  let applied = false
  groups.mockResolvedValue({
    projectGroups: [group],
    hostId: environmentId ? `runtime:${environmentId}` : 'local'
  })
  folders.mockResolvedValue({
    folderWorkspaces: [folder],
    hostId: environmentId ? `runtime:${environmentId}` : 'local'
  })
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'repo.list') {
      return { repos: [] }
    }
    if (method === 'worktree.set') {
      applied = true
      return { worktree: child }
    }
    if (method === 'worktree.lineageList') {
      return { lineage: {}, workspaceLineage: applied ? { [edge.childWorkspaceKey]: edge } : {} }
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  return {
    store,
    context,
    child,
    edge,
    folder,
    markApplied: () => {
      applied = true
    }
  }
}

beforeEach(() => vi.clearAllMocks())

function mutationCalls() {
  return rpc.mock.calls.filter((call) => call[1] === 'worktree.set')
}

describe('folder parent actions', () => {
  it('routes local writes through exact identity and confirms a null Git parent from workspace lineage', async () => {
    const fixture = setup()
    await fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    expect(mutationCalls()).toHaveLength(1)
    expect(mutationCalls()[0].slice(0, 3)).toEqual([
      { kind: 'local' },
      'worktree.set',
      { worktree: fixture.context.selector, parentWorktree: 'folder:folder' }
    ])
    expect(
      fixture.store.getState().workspaceLineageByChildKey[fixture.edge.childWorkspaceKey]
    ).toEqual(fixture.edge)
  })
  it('uses captured paired ownership even if another runtime is focused', async () => {
    const fixture = setup('owner')
    fixture.store.setState({ activeWorktreeId: 'unrelated' })
    await fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    expect(rpc.mock.calls.every((call) => call[0].environmentId === 'owner')).toBe(true)
    expect(groups).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'owner' })
  })
  it('refuses a replaced checkout without sending a mutation', async () => {
    const fixture = setup()
    fixture.store.setState({
      worktreesByRepo: { repo1: [{ ...fixture.child, instanceId: 'replacement' }] }
    })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'rejected' })
    expect(mutationCalls()).toHaveLength(0)
  })
  it('does not mutate when the selected folder disappeared', async () => {
    const fixture = setup()
    folders.mockResolvedValue({ folderWorkspaces: [], hostId: 'local' })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'rejected' })
    expect(mutationCalls()).toHaveLength(0)
  })
  it('preserves a previous parent when backend rejects the write', async () => {
    const fixture = setup()
    const previous = makeLineage({
      worktreeId: fixture.child.id,
      worktreeInstanceId: fixture.child.instanceId
    })
    fixture.store.setState({ worktreeLineageById: { [fixture.child.id]: previous } })
    const implementation = rpc.getMockImplementation()
    rpc.mockImplementation(async (...args) => {
      if (args[1] === 'worktree.set') {
        throw new RuntimeRpcCallError({
          id: 'rejected',
          ok: false,
          error: { code: 'LINEAGE_PARENT_CONTEXT_CONFLICT', message: 'Host mismatch' },
          _meta: { runtimeId: 'host' }
        })
      }
      return implementation?.(...args)
    })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'rejected' })
    expect(fixture.store.getState().worktreeLineageById[fixture.child.id]).toBe(previous)
  })
  it('removes obsolete Git parent presentation only for the confirmed occupant', async () => {
    const fixture = setup()
    const previous = makeLineage({
      worktreeId: fixture.child.id,
      worktreeInstanceId: fixture.child.instanceId
    })
    const withLineage: WorktreeWithLineage = {
      ...fixture.child,
      parentWorktreeId: previous.parentWorktreeId,
      lineage: previous
    }
    fixture.store.setState({
      worktreeLineageById: { [fixture.child.id]: previous },
      worktreesByRepo: { repo1: [withLineage] }
    })
    await fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    expect(fixture.store.getState().worktreeLineageById[fixture.child.id]).toBeUndefined()
    expect(fixture.store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      parentWorktreeId: null,
      lineage: null
    })
  })
  it('does not erase a newer detach when an earlier verification arrives', async () => {
    const fixture = setup()
    const old = { ...fixture.edge, parentWorkspaceKey: folderWorkspaceKey('previous') }
    fixture.store.setState({
      workspaceLineageByChildKey: { [fixture.edge.childWorkspaceKey]: old }
    })
    const implementation = rpc.getMockImplementation()
    let reads = 0
    rpc.mockImplementation(async (...args) => {
      if (args[1] === 'worktree.lineageList' && ++reads === 2) {
        fixture.store.setState({ workspaceLineageByChildKey: {} })
      }
      return implementation?.(...args)
    })
    await fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    expect(fixture.store.getState().workspaceLineageByChildKey).toEqual({})
  })
  it('refuses to overwrite a same-ID parent owned by another instance', async () => {
    const fixture = setup()
    const foreign = { ...fixture.edge, childInstanceId: 'foreign-instance' }
    fixture.store.setState({ workspaceLineageByChildKey: { [foreign.childWorkspaceKey]: foreign } })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'rejected' })
    expect(mutationCalls()).toHaveLength(0)
    expect(fixture.store.getState().workspaceLineageByChildKey[foreign.childWorkspaceKey]).toBe(
      foreign
    )
  })

  it('blocks detachment while the same captured parent mutation is in flight', async () => {
    const fixture = setup()
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const implementation = rpc.getMockImplementation()
    rpc.mockImplementation(async (...args) => {
      if (args[1] === 'worktree.set') {
        markStarted?.()
        await held
      }
      return implementation?.(...args)
    })
    const first = fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    await started
    await expect(
      fixture.store.getState().updateWorktreeLineage(fixture.child.id, { noParent: true })
    ).rejects.toThrow('already in progress')
    release?.()
    await first
    expect(mutationCalls()).toHaveLength(1)
  })

  it('distinguishes missing workspace evidence from confirmed empty evidence', () => {
    expect(normalizeLineageResponse({ lineage: {} }).workspaceLineageAvailable).toBe(false)
    expect(
      normalizeLineageResponse({ lineage: {}, workspaceLineage: {} }).workspaceLineageAvailable
    ).toBe(true)
  })
  it('does not send a write to an older host with no folder lineage evidence', async () => {
    const fixture = setup()
    rpc.mockImplementation(async (_target, method) =>
      method === 'repo.list' ? { repos: [] } : { lineage: {} }
    )
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'rejected' })
    expect(mutationCalls()).toHaveLength(0)
  })
  it('reports acknowledgement separately if verification fails', async () => {
    const fixture = setup()
    const implementation = rpc.getMockImplementation()
    let reads = 0
    rpc.mockImplementation(async (...args) => {
      if (args[1] === 'worktree.lineageList' && ++reads === 2) {
        throw new Error('Connection lost')
      }
      return implementation?.(...args)
    })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'acknowledged' })
    expect(fixture.store.getState().workspaceLineageByChildKey).toEqual({})
  })
  it('reconciles unknown outcomes before a repeat and never automatically resends', async () => {
    const fixture = setup()
    const implementation = rpc.getMockImplementation()
    rpc.mockImplementation(async (...args) => {
      if (args[1] === 'worktree.set') {
        throw new Error('Timed out')
      }
      return implementation?.(...args)
    })
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toBeInstanceOf(FolderParentMutationError)
    await expect(
      fixture.store.getState().attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    ).rejects.toMatchObject({ outcome: 'unknown' })
    expect(mutationCalls()).toHaveLength(1)
    fixture.markApplied()
    await fixture.store.getState().loadFolderParentCatalog(fixture.context)
    await fixture.store
      .getState()
      .attachWorktreeToFolderWorkspace(fixture.context, fixture.folder.id)
    expect(mutationCalls()).toHaveLength(1)
  })
})
