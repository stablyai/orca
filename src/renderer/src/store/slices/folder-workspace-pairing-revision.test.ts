import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { toRemoteRuntimePtyId } from '../../runtime/runtime-terminal-stream'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

vi.mock('@/components/terminal-pane/terminal-parked-watcher-registry', () => ({
  capturedPanesByTabId: new Map(),
  disposeParkedTerminalWatchersForPtyIds: vi.fn(),
  disposeRemovedWorktreeParkedTerminalWatchers: vi.fn(),
  retireParkedTerminalTab: vi.fn()
}))

const ENVIRONMENT_ID = 'env-folder-delete'
const OWNER_HOST_ID = toRuntimeExecutionHostId(ENVIRONMENT_ID)
const ACTIVE_ENVIRONMENT_ID = 'env-active-sibling'
const ACTIVE_HOST_ID = toRuntimeExecutionHostId(ACTIVE_ENVIRONMENT_ID)
const CAPTURED_REVISION = 41
const REPLACEMENT_REVISION = 42
const runtimeEnvironmentCall = vi.fn()

type RuntimeCall = {
  selector: string
  method: string
  params?: Record<string, unknown>
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function runtimeResponse(method: string, result: Record<string, unknown>) {
  return {
    id: method,
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime-folder-delete' }
  }
}

function revisionFailure(method: string) {
  return {
    id: method,
    ok: false as const,
    error: {
      code: 'runtime_environment_changed',
      message: 'Runtime environment pairing changed; refresh and try again'
    },
    _meta: { runtimeId: 'replacement-runtime' }
  }
}

function statusResponse(backendOwnsTeardown = false, ownerQualifiedDelete = true) {
  return runtimeResponse('status.get', {
    runtimeId: 'runtime-folder-delete',
    graphStatus: 'ready',
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: [
      ...(backendOwnsTeardown ? [FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY] : []),
      ...(ownerQualifiedDelete ? [FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY] : [])
    ]
  })
}

function makeGroup(
  id = 'group-root',
  parentGroupId: string | null = null,
  executionHostId = OWNER_HOST_ID
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

function makeWorkspace(
  id: string,
  projectGroupId: string,
  name = id,
  executionHostId = OWNER_HOST_ID
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name,
    folderPath: `/workspace/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

function makeRepo(
  id: string,
  projectGroupId: string,
  executionHostId: NonNullable<Repo['executionHostId']>
): Repo {
  return {
    id,
    path: `/repo/${encodeURIComponent(executionHostId)}`,
    displayName: id,
    badgeColor: '#111',
    addedAt: 1,
    projectGroupId,
    executionHostId
  }
}

function seedRuntimeWorkspace(
  store: ReturnType<typeof createTestStore>,
  groups: ProjectGroup[],
  workspaces: FolderWorkspace[]
): void {
  const tabs = workspaces.map((workspace) => {
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const ptyId = toRemoteRuntimePtyId(`handle-${workspace.id}`, ENVIRONMENT_ID)
    return {
      workspaceKey,
      ptyId,
      tab: makeTab({ id: `tab-${workspace.id}`, worktreeId: workspaceKey, ptyId })
    }
  })
  store.setState({
    settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID } as never,
    projectGroups: groups,
    folderWorkspaces: workspaces,
    tabsByWorktree: Object.fromEntries(tabs.map(({ workspaceKey, tab }) => [workspaceKey, [tab]])),
    ptyIdsByTabId: Object.fromEntries(tabs.map(({ ptyId, tab }) => [tab.id, [ptyId]]))
  })
}

function instrumentRendererTeardown(store: ReturnType<typeof createTestStore>) {
  const shutdownWorktreeBrowsers = vi.fn().mockResolvedValue(undefined)
  const shutdownWorktreeTerminals = vi.fn().mockResolvedValue(undefined)
  const purgeWorktreeTerminalState = vi.fn()
  const closeTab = vi.fn()
  store.setState({
    closeTab,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals,
    purgeWorktreeTerminalState
  })
  return {
    closeTab,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals,
    purgeWorktreeTerminalState
  }
}

function setRevision(pairingRevision: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision }])
}

function setDuplicateHostRevisions(): void {
  replaceRuntimeEnvironmentRevisions([
    { id: ACTIVE_ENVIRONMENT_ID, createdAt: 1, pairingRevision: 31 },
    { id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: CAPTURED_REVISION }
  ])
}

function seedDuplicateHostWorkspace(
  store: ReturnType<typeof createTestStore>,
  groups: ProjectGroup[],
  workspaces: FolderWorkspace[],
  repos: Repo[] = []
) {
  const workspaceKey = folderWorkspaceKey(workspaces[0]!.id)
  const activePtyId = toRemoteRuntimePtyId('handle-active', ACTIVE_ENVIRONMENT_ID)
  const targetPtyId = toRemoteRuntimePtyId('handle-target', ENVIRONMENT_ID)
  const activeTab = makeTab({ id: 'tab-active', worktreeId: workspaceKey, ptyId: activePtyId })
  const targetTab = makeTab({ id: 'tab-target', worktreeId: workspaceKey, ptyId: targetPtyId })
  store.setState({
    settings: { activeRuntimeEnvironmentId: ACTIVE_ENVIRONMENT_ID } as never,
    projectGroups: groups,
    folderWorkspaces: workspaces,
    repos,
    tabsByWorktree: { [workspaceKey]: [activeTab, targetTab] },
    ptyIdsByTabId: {
      [activeTab.id]: [activePtyId],
      [targetTab.id]: [targetPtyId]
    }
  })
  const closeTab = vi.fn(store.getState().closeTab)
  store.setState({ closeTab })
  return { activeTab, closeTab, targetTab, workspaceKey }
}

function expectCallsBoundToCapturedRevision(): void {
  expect(runtimeEnvironmentCall).toHaveBeenCalled()
  for (const [request] of runtimeEnvironmentCall.mock.calls as [RuntimeCall][]) {
    expect(request.selector).toBe(ENVIRONMENT_ID)
    expect(request.expectedEnvironmentPairingRevision).toBe(CAPTURED_REVISION)
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([])
  setRevision(CAPTURED_REVISION)
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

describe('folder workspace pairing revision fences', () => {
  it('binds legacy folder deletion rejection to one pairing revision', async () => {
    const group = makeGroup()
    const workspace = makeWorkspace('folder-explicit', group.id)
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse()
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [group], [workspace])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      store.getState().deleteFolderWorkspace(workspace.id, { hostId: OWNER_HOST_ID })
    ).resolves.toBe(false)
    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get'
    ])
    expectCallsBoundToCapturedRevision()
    expect(store.getState().folderWorkspaces).toEqual([workspace])
    warn.mockRestore()
  })

  it('binds legacy project-group deletion rejection to one pairing revision', async () => {
    const root = makeGroup()
    const child = makeGroup('group-child', root.id)
    const workspaces = [
      makeWorkspace('folder-root', root.id),
      makeWorkspace('folder-child', child.id)
    ]
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse()
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [root, child], workspaces)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      store.getState().deleteProjectGroup(root.id, { hostId: OWNER_HOST_ID })
    ).resolves.toBe(false)
    expectCallsBoundToCapturedRevision()
    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get'
    ])
    expect(store.getState().projectGroups).toEqual([root, child])
    expect(store.getState().folderWorkspaces).toEqual(workspaces)
    warn.mockRestore()
  })

  it('deletes a same-ID folder only from its explicit host', async () => {
    const groupId = 'group-duplicate'
    const workspaceId = 'folder-duplicate'
    const activeGroup = makeGroup(groupId, null, ACTIVE_HOST_ID)
    const targetGroup = makeGroup(groupId, null, OWNER_HOST_ID)
    const activeWorkspace = makeWorkspace(workspaceId, groupId, 'Active workspace', ACTIVE_HOST_ID)
    const targetWorkspace = makeWorkspace(workspaceId, groupId, 'Target workspace', OWNER_HOST_ID)
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.method === 'folderWorkspace.delete') {
        return runtimeResponse(request.method, { deleted: true })
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    setDuplicateHostRevisions()
    const { activeTab, closeTab, targetTab, workspaceKey } = seedDuplicateHostWorkspace(
      store,
      [activeGroup, targetGroup],
      [activeWorkspace, targetWorkspace]
    )

    await expect(
      store.getState().deleteFolderWorkspace(workspaceId, { hostId: OWNER_HOST_ID })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'folderWorkspace.delete'
    ])
    expectCallsBoundToCapturedRevision()
    expect(store.getState().projectGroups).toEqual([activeGroup, targetGroup])
    expect(store.getState().folderWorkspaces).toEqual([activeWorkspace])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([activeTab])
    expect(store.getState().ptyIdsByTabId[activeTab.id]).toEqual([activeTab.ptyId])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toBeUndefined()
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith(
      targetTab.id,
      expect.objectContaining({ reason: 'cleanup' })
    )
  })

  it('deletes a same-ID group and contained project only from its explicit host', async () => {
    const groupId = 'group-duplicate'
    const workspaceId = 'folder-duplicate'
    const repoId = 'repo-duplicate'
    const activeGroup = makeGroup(groupId, null, ACTIVE_HOST_ID)
    const targetGroup = makeGroup(groupId, null, OWNER_HOST_ID)
    const activeWorkspace = makeWorkspace(workspaceId, groupId, 'Active workspace', ACTIVE_HOST_ID)
    const targetWorkspace = makeWorkspace(workspaceId, groupId, 'Target workspace', OWNER_HOST_ID)
    const activeRepo = makeRepo(repoId, groupId, ACTIVE_HOST_ID)
    const targetRepo = makeRepo(repoId, groupId, OWNER_HOST_ID)
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.method === 'projectGroup.delete') {
        return runtimeResponse(request.method, { deleted: true })
      }
      if (request.method === 'repo.rm') {
        return runtimeResponse(request.method, {})
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    setDuplicateHostRevisions()
    const { activeTab, closeTab, targetTab, workspaceKey } = seedDuplicateHostWorkspace(
      store,
      [activeGroup, targetGroup],
      [activeWorkspace, targetWorkspace],
      [activeRepo, targetRepo]
    )

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(groupId, {
        hostId: OWNER_HOST_ID,
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId,
      requestedProjectIds: [repoId],
      removedProjectIds: [repoId],
      failedProjectRemovals: []
    })

    expect(
      runtimeEnvironmentCall.mock.calls.map(([request]) => [request.selector, request.method])
    ).toEqual([
      [ENVIRONMENT_ID, 'status.get'],
      [ENVIRONMENT_ID, 'projectGroup.delete'],
      [ENVIRONMENT_ID, 'repo.rm']
    ])
    expectCallsBoundToCapturedRevision()
    expect(store.getState().projectGroups).toEqual([activeGroup])
    expect(store.getState().folderWorkspaces).toEqual([activeWorkspace])
    expect(store.getState().repos).toEqual([activeRepo])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([activeTab])
    expect(store.getState().ptyIdsByTabId[activeTab.id]).toEqual([activeTab.ptyId])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toBeUndefined()
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith(
      targetTab.id,
      expect.objectContaining({ reason: 'cleanup' })
    )
  })

  it('keeps the wrapper fence when re-paired before repo.rm', async () => {
    const group = makeGroup('group-contained')
    const repo = makeRepo('repo-contained', group.id, OWNER_HOST_ID)
    let currentRevision = CAPTURED_REVISION
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.expectedEnvironmentPairingRevision !== currentRevision) {
        return revisionFailure(request.method)
      }
      return runtimeResponse(request.method, { deleted: true })
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [group], [])
    store.setState({ repos: [repo] })
    const deleteProjectGroup = store.getState().deleteProjectGroup
    store.setState({
      deleteProjectGroup: async (...args) => {
        const deleted = await deleteProjectGroup(...args)
        currentRevision = REPLACEMENT_REVISION
        setRevision(REPLACEMENT_REVISION)
        return deleted
      }
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(group.id, {
        hostId: OWNER_HOST_ID,
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: group.id,
      requestedProjectIds: [repo.id],
      removedProjectIds: [],
      failedProjectRemovals: [
        {
          projectId: repo.id,
          reason: 'Project remained in Orca after removeProject completed.'
        }
      ]
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'projectGroup.delete',
      'repo.rm'
    ])
    expectCallsBoundToCapturedRevision()
    expect(store.getState().projectGroups).toEqual([])
    expect(store.getState().repos).toEqual([{ ...repo, projectGroupId: null }])
    consoleError.mockRestore()
  })

  it('keeps renderer project state when re-paired between repo.rm and terminal.stop', async () => {
    const group = makeGroup('group-terminal-stop')
    const repo = makeRepo('repo-terminal-stop', group.id, OWNER_HOST_ID)
    const worktreeId = `${repo.id}::/workspace/repo-terminal-stop`
    const worktree = makeWorktree({
      id: worktreeId,
      repoId: repo.id,
      hostId: OWNER_HOST_ID
    })
    const ptyId = toRemoteRuntimePtyId('handle-repo-terminal-stop', ENVIRONMENT_ID)
    const tab = makeTab({ id: 'tab-repo-terminal-stop', worktreeId, ptyId })
    let currentRevision = CAPTURED_REVISION
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.expectedEnvironmentPairingRevision !== currentRevision) {
        return revisionFailure(request.method)
      }
      return runtimeResponse(request.method, {})
    })
    const store = createTestStore()
    const purgeWorktreeTerminalState = vi.fn()
    store.setState({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID } as never,
      projectGroups: [group],
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktreeId]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ptyId] },
      clearOrcaHookTrustForRepo: vi.fn(() => {
        queueMicrotask(() => {
          currentRevision = REPLACEMENT_REVISION
          setRevision(REPLACEMENT_REVISION)
        })
      }),
      purgeWorktreeTerminalState
    })

    await store.getState().removeProject(repo.id, { hostId: OWNER_HOST_ID })

    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'repo.rm',
      'terminal.stop'
    ])
    expectCallsBoundToCapturedRevision()
    expect(store.getState().repos).toEqual([repo])
    expect(store.getState().worktreesByRepo[repo.id]).toEqual([worktree])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([tab])
    expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([ptyId])
    expect(purgeWorktreeTerminalState).not.toHaveBeenCalled()
  })

  it('adopts delayed catalog teardown after a newer empty catalog keeps the owner absent', async () => {
    const group = makeGroup()
    const workspace = makeWorkspace('folder-catalog', group.id)
    const delayedCapability = deferred<ReturnType<typeof runtimeResponse>>()
    let statusCalls = 0
    let listCalls = 0
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        statusCalls += 1
        return statusCalls === 1 ? statusResponse() : delayedCapability.promise
      }
      if (request.method === 'folderWorkspace.list') {
        listCalls += 1
        if (listCalls === 1) {
          clearRuntimeCompatibilityCacheForTests()
        }
        return runtimeResponse(request.method, { folderWorkspaces: [] })
      }
      return runtimeResponse(request.method, { close: { closed: true } })
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [group], [workspace])
    const teardown = instrumentRendererTeardown(store)

    const staleFetch = store
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: ENVIRONMENT_ID })
    await vi.waitFor(() => expect(statusCalls).toBe(2))
    const freshFetch = store
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: ENVIRONMENT_ID })
    delayedCapability.resolve(statusResponse())
    await Promise.all([staleFetch, freshFetch])

    expect(listCalls).toBe(2)
    expect(
      runtimeEnvironmentCall.mock.calls.filter(([request]) => request.method === 'terminal.close')
    ).toHaveLength(1)
    expect(teardown.closeTab).not.toHaveBeenCalled()
    const workspaceKey = folderWorkspaceKey(workspace.id)
    expect(teardown.shutdownWorktreeBrowsers).toHaveBeenCalledOnce()
    expect(teardown.shutdownWorktreeBrowsers).toHaveBeenCalledWith(workspaceKey)
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledOnce()
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledWith(
      workspaceKey,
      expect.objectContaining({
        shutdownReason: 'remove-worktree',
        backendOwnsPtyTeardown: true
      })
    )
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledOnce()
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledWith([workspaceKey])
    expect(store.getState().folderWorkspaces).toEqual([])
    expectCallsBoundToCapturedRevision()
  })

  it('does not apply an old successful delete after the environment is re-paired', async () => {
    const group = makeGroup()
    const original = makeWorkspace('folder-inflight-delete', group.id, 'Original')
    const replacement = { ...original, name: 'Replacement', updatedAt: 2 }
    const deleteResponse = deferred<ReturnType<typeof runtimeResponse>>()
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.method === 'folderWorkspace.delete') {
        return deleteResponse.promise
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [group], [original])
    const teardown = instrumentRendererTeardown(store)

    const deletion = store.getState().deleteFolderWorkspace(original.id, { hostId: OWNER_HOST_ID })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'folderWorkspace.delete' })
      )
    )
    setRevision(REPLACEMENT_REVISION)
    seedRuntimeWorkspace(store, [group], [replacement])
    deleteResponse.resolve(runtimeResponse('folderWorkspace.delete', { deleted: true }))

    await expect(deletion).resolves.toBe(false)
    expect(store.getState().folderWorkspaces).toEqual([replacement])
    expect(store.getState().tabsByWorktree[folderWorkspaceKey(replacement.id)]).toHaveLength(1)
    expect(teardown.closeTab).not.toHaveBeenCalled()
    expect(teardown.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    expect(teardown.shutdownWorktreeTerminals).not.toHaveBeenCalled()
    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expectCallsBoundToCapturedRevision()
  })

  it('invalidates terminal cleanup when the environment re-pairs during its awaited stop', async () => {
    const group = makeGroup()
    const original = makeWorkspace('folder-mid-teardown', group.id, 'Original')
    const replacement = { ...original, name: 'Replacement', updatedAt: 2 }
    const terminalShutdown = deferred<void>()
    runtimeEnvironmentCall.mockImplementation((request: RuntimeCall) => {
      if (request.method === 'status.get') {
        return statusResponse(true)
      }
      if (request.method === 'folderWorkspace.delete') {
        return runtimeResponse(request.method, { deleted: true })
      }
      throw new Error(`Unexpected runtime method: ${request.method}`)
    })
    const store = createTestStore()
    seedRuntimeWorkspace(store, [group], [original])
    const teardown = instrumentRendererTeardown(store)
    let terminalFence: (() => boolean) | undefined
    teardown.shutdownWorktreeTerminals.mockImplementation(
      (_workspaceKey: string, options?: { isCurrent?: () => boolean }) => {
        terminalFence = options?.isCurrent
        return terminalShutdown.promise
      }
    )

    const deletion = store.getState().deleteFolderWorkspace(original.id, {
      hostId: OWNER_HOST_ID
    })
    await vi.waitFor(() => expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledOnce())
    expect(terminalFence?.()).toBe(true)

    setRevision(REPLACEMENT_REVISION)
    seedRuntimeWorkspace(store, [group], [replacement])
    expect(terminalFence?.()).toBe(false)
    terminalShutdown.resolve()

    await expect(deletion).resolves.toBe(true)
    expect(store.getState().folderWorkspaces).toEqual([replacement])
    expect(store.getState().tabsByWorktree[folderWorkspaceKey(replacement.id)]).toHaveLength(1)
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledOnce()
    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expectCallsBoundToCapturedRevision()
  })
})
