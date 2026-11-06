// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import type * as launchModule from './agent-session/launch/structured-agent-session-launch-create-call'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecords,
  resetStructuredAgentLaunchPersistenceForTests
} from './agent-session/launch/structured-agent-session-launch-persistence'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './agent-session/launch/structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { structuredAgentSessionSendBody } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { restoreStructuredLaunchSurfaces } from './agent-session/launch/structured-agent-session-launch-restore'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/native-chat-composer-draft-store'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>(),
  hostLaunch: vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})),
  // Each paired host's folder catalog reply, by environment id.
  folders: new Map<string, () => Promise<{ folderWorkspaces: FolderWorkspace[] }>>(),
  rpc: [] as string[]
}))
vi.mock('./agent-session/launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.createSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
      const [target, method, params] = args
      mocks.rpc.push(method)
      if (method === 'folderWorkspace.list' && target.kind === 'environment') {
        return mocks.folders.get(target.environmentId)!()
      }
      if (method === 'folderWorkspace.delete') {
        return Promise.resolve({ deleted: true })
      }
      return method.startsWith('agent.launch') || method === 'agentSession.history'
        ? mocks.hostLaunch(method, params)
        : client.callRuntimeRpc(...args)
    }
  }
})
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)

const initialState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const LAUNCHES = 'orca:structuredAgentLaunches:v1'
const FOLDER = 'folder-1'
const KEY = folderWorkspaceKey(FOLDER)
let main: TabsDrawnFromMain
const api = window as unknown as { api?: Record<string, unknown> }
const originalApi = api.api

const folder = (id: string): FolderWorkspace => ({
  id,
  projectGroupId: 'group-env-1',
  name: id,
  folderPath: `/srv/${id}`,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
})

/** A saved host launch for runtime:env-1, held in `folderId`'s workspace, no tab saved. */
const heldRow = (sessionId: string, folderId = FOLDER, host = 'runtime:env-1') => ({
  sessionId,
  executionHostId: host,
  agent: 'codex',
  lifecycle: 'failed',
  clientOperationId: `op-${sessionId}`,
  payloadFingerprint: 'fingerprint',
  expectedRuntimeFence: null,
  surfaceAddress: { worktreeId: folderWorkspaceKey(folderId), precedingTabIds: [] },
  hostLaunchOperationId: `host-op-${sessionId}`,
  firstMessage: {
    clientMessageId: `held-${sessionId}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Recover this' }] }
  }
})

const savedLaunch = (sessionId: string) =>
  (JSON.parse(localStorage.getItem(LAUNCHES) ?? '[]') as Record<string, unknown>[]).find(
    (row) => row.sessionId === sessionId
  )
const chatTabs = (sessionId: string, key = KEY) =>
  (useAppStore.getState().unifiedTabsByWorktree[key] ?? []).filter(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
const launchRpcs = () => mocks.rpc.filter((method) => /^agent(Session)?\./.test(method))

/** Each paired host's catalog answers with these folders; `null` fails the read. */
function hostFolders(byEnvironment: Record<string, FolderWorkspace[] | null>): void {
  for (const [environmentId, folders] of Object.entries(byEnvironment)) {
    mocks.folders.set(environmentId, async () => {
      if (!folders) {
        throw new Error('runtime_unreachable')
      }
      return { folderWorkspaces: folders }
    })
  }
}

async function settled(): Promise<void> {
  await vi.dynamicImportSettled()
  await main.settle()
}

/** The all-host catalog load startup and reconnects run, applied by the store's own writer. */
async function loadAllHostFolders(): Promise<void> {
  await useAppStore.getState().fetchFolderWorkspacesForAllHosts()
  await settled()
}

/** One host's refresh, as the runtime project refresh runs it. */
async function refreshHostFolders(environmentId = 'env-1'): Promise<void> {
  await useAppStore.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })
  await settled()
}

/** Saves `rows`, then starts as a reload does: env-1's cached partition read fails. */
async function reloadWithUnreadablePartition(rows: unknown[]): Promise<void> {
  localStorage.setItem(LAUNCHES, JSON.stringify(rows))
  resetStructuredAgentLaunchPersistenceForTests()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
    {
      get: async (hostId) => {
        if (hostId) {
          throw new Error('partition unreadable')
        }
        return getDefaultWorkspaceSession()
      }
    },
    [],
    ['runtime:env-1']
  )
  warn.mockRestore()
  useAppStore.setState({
    restoredRuntimeHostIdByWorkspaceSessionKey: read.runtimeHostIdByWorkspaceSessionKey
  })
  restoreStructuredLaunchSurfaces()
  await settled()
}

/** env-1's listing of the repo, applied by the store's own worktree writer. */
function listRepo(rows: Worktree[]): void {
  const outcome = mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
    repoId: worktree.repoId,
    hostId: 'runtime:env-1',
    ownerWasMissingAtStart: false,
    requestStartedWorktrees: useAppStore.getState().worktreesByRepo[worktree.repoId],
    refresh: {
      status: 'admitted',
      executionHostId: 'runtime:env-1',
      result: {
        repoId: worktree.repoId,
        authoritative: true,
        source: 'metadata-fallback',
        worktrees: rows.map((entry) => ({
          ...entry,
          ownership: 'orca-managed' as const,
          selectedCheckout: false,
          visible: true
        }))
      }
    }
  })
  expect(outcome).toBe('applied')
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.rpc.length = 0
  mocks.folders.clear()
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState({ worktreesByRepo: {}, folderWorkspaces: [], projectGroups: [] })
  api.api = {
    ...originalApi,
    folderWorkspaces: { list: vi.fn(async () => []) },
    runtimeEnvironments: { list: vi.fn(async () => [{ id: 'env-1' }, { id: 'env-2' }]) }
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  api.api = originalApi
  vi.restoreAllMocks()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  // Tombstones too: a later case reuses these session ids.
  localStorage.clear()
  useAppStore.setState(initialState, true)
})

describe('a held host launch in a folder whose startup read failed', () => {
  it('comes back once its own host lists the folder, with no repo listing at all', async () => {
    await reloadWithUnreadablePartition([heldRow('codex-folder')])
    expect(chatTabs('codex-folder')).toEqual([])

    // Another host listing the same folder id, its own host unreadable: neither shown nor ended.
    hostFolders({ 'env-1': null, 'env-2': [folder(FOLDER)] })
    await loadAllHostFolders()
    expect(chatTabs('codex-folder')).toEqual([])
    expect(savedLaunch('codex-folder')).toBeDefined()

    // A reply overtaken by a newer read of the same host neither shows nor ends it.
    const stale = Promise.withResolvers<{ folderWorkspaces: FolderWorkspace[] }>()
    mocks.folders.set('env-1', () => stale.promise)
    const overtaken = useAppStore
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })
    hostFolders({ 'env-1': null })
    await refreshHostFolders()
    stale.resolve({ folderWorkspaces: [] })
    await overtaken
    await settled()
    expect(savedLaunch('codex-folder')).toBeDefined()
    expect(chatTabs('codex-folder')).toEqual([])

    // Its own host's catalog, before its project group arrives, shows it. (The other host's copy
    // is gone first: as with a repo twin, a main-owned layout draws one host's copy of an id.)
    hostFolders({ 'env-1': [folder(FOLDER)], 'env-2': [] })
    await loadAllHostFolders()
    expect(chatTabs('codex-folder')).toMatchObject([{ executionHostId: 'runtime:env-1' }])

    // Unchanged catalogs after the group arrives, again and again: still exactly one chat.
    useAppStore.setState({
      projectGroups: [
        {
          id: 'group-env-1',
          name: 'env-1',
          parentPath: '/srv',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ]
    })
    await refreshHostFolders()
    await loadAllHostFolders()
    expect(chatTabs('codex-folder')).toHaveLength(1)
    expect(getStructuredAgentSessionLaunchLifecycle(KEY, 'codex-folder')).toBe('failed')
    expect(savedLaunch('codex-folder')).toMatchObject({
      firstMessage: { clientMessageId: 'held-codex-folder' }
    })
    // Only drawn: nothing accepted, read, created or sent.
    expect(launchRpcs()).toEqual([])
    expect(mocks.createSession).not.toHaveBeenCalled()

    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      // A tab lost without its launch ending comes back with the next catalog, once.
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [KEY]: state.unifiedTabsByWorktree[KEY]!.filter((tab) => tab.entityId !== 'codex-folder')
        }
      }))
      await refreshHostFolders()
      expect(chatTabs('codex-folder')).toHaveLength(1)
    }

    // Retry reads the host's record of this same launch, whatever it says; it starts nothing.
    mocks.hostLaunch.mockImplementation(async () => ({ state: 'unknown' }))
    expect(retryStructuredAgentSessionLaunch(KEY, 'codex-folder')).toBe(true)
    await vi.waitFor(() =>
      expect(getStructuredAgentSessionLaunchLifecycle(KEY, 'codex-folder')).toBe(
        'visibility-unknown'
      )
    )
    expect(launchRpcs().every((method) => method === 'agent.launchStatus')).toBe(true)
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('stays drawn as unrelated repo listings settle, and ends when its own host drops the folder', async () => {
    const repo = useAppStore.getState().repos[0]!
    useAppStore.setState({ repos: [{ ...repo, executionHostId: 'runtime:env-1' }] })
    await reloadWithUnreadablePartition([
      heldRow('codex-folder'),
      heldRow('codex-twin', FOLDER, 'runtime:env-2')
    ])

    // A repo listing alone never names the folder.
    listRepo([{ ...worktree, hostId: 'runtime:env-1' }])
    await settled()
    expect(chatTabs('codex-folder')).toEqual([])

    hostFolders({ 'env-1': [folder(FOLDER)], 'env-2': null })
    await refreshHostFolders()
    listRepo([{ ...worktree, hostId: 'runtime:env-1' }])
    listRepo([])
    await settled()
    expect(chatTabs('codex-folder')).toHaveLength(1)
    expect(savedLaunch('codex-folder')).toBeDefined()

    // A failed read proves nothing; its own host's catalog without the folder ends the launch.
    hostFolders({ 'env-1': null })
    await refreshHostFolders()
    expect(savedLaunch('codex-folder')).toBeDefined()
    hostFolders({ 'env-1': [] })
    await refreshHostFolders()
    expect(savedLaunch('codex-folder')).toBeUndefined()
    // Another host's launch under the same folder id is untouched.
    expect(savedLaunch('codex-twin')).toBeDefined()

    // A later catalog listing the folder again brings nothing back.
    hostFolders({ 'env-1': [folder(FOLDER)] })
    await refreshHostFolders()
    expect(chatTabs('codex-folder').length).toBeLessThanOrEqual(1)
    expect(savedLaunch('codex-folder')).toBeUndefined()
    expect(launchRpcs()).toEqual([])
  })

  it('ends only saved launches in folders a catalog omits, never one live in this window', async () => {
    await reloadWithUnreadablePartition([heldRow('codex-saved', 'folder-gone')])
    // A catalog read starts, then a folder is created on env-1 and a chat launched into it.
    const older = Promise.withResolvers<{ folderWorkspaces: FolderWorkspace[] }>()
    mocks.folders.set('env-1', () => older.promise)
    const reading = useAppStore.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })
    useAppStore.setState({
      folderWorkspaces: [{ ...folder('folder-new'), executionHostId: 'runtime:env-1' }]
    })
    const message = {
      clientMessageId: 'held-live',
      body: structuredAgentSessionSendBody('Fresh', [])
    }
    startStructuredAgentLaunch(folderWorkspaceKey('folder-new'), 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:env-1',
      // As the provisional chat saves it: where its tab goes.
      surfaceAddress: { worktreeId: folderWorkspaceKey('folder-new'), precedingTabIds: [] },
      prompt: 'Fresh',
      hostLaunch: {
        operationId: 'host-op-live',
        sessionId: 'codex-live',
        firstMessage: message,
        accept: {
          prompt: { text: 'Fresh', clientMessageId: 'held-live' },
          presentation: 'focused' as const,
          setupReceipt: { required: true as const, runId: 'setup-run' }
        }
      }
    } as Parameters<typeof startStructuredAgentLaunch>[2])
    await vi.waitFor(() => expect(savedLaunch('codex-live')).toBeDefined())

    // The older read lists neither folder.
    older.resolve({ folderWorkspaces: [] })
    await reading
    await settled()
    expect(getStructuredLaunchStateBySessionId('codex-live')).toBeDefined()
    expect(savedLaunch('codex-live')).toMatchObject({
      firstMessage: { clientMessageId: 'held-live' }
    })
    expect(savedLaunch('codex-saved')).toBeUndefined()
  })

  it.each(['folder deletion', 'removal'] as const)(
    "ends a launch with its own host's %s, and only that host's",
    async (removal) => {
      await reloadWithUnreadablePartition([
        heldRow('codex-folder'),
        heldRow('codex-twin', FOLDER, 'runtime:env-2')
      ])
      // env-2 never answers: its launch under the same folder id is saved only, never loaded.
      hostFolders({ 'env-1': [folder(FOLDER)], 'env-2': null })
      if (removal === 'folder deletion') {
        await loadAllHostFolders()
        expect(
          await useAppStore
            .getState()
            .deleteFolderWorkspace(FOLDER, { executionHostId: 'runtime:env-1' })
        ).toBe(true)
      } else {
        useAppStore.getState().purgeStaleRuntimeHostState(['env-1'])
        await loadAllHostFolders()
      }
      expect(chatTabs('codex-folder')).toEqual([])
      await settled()
      expect(savedLaunch('codex-folder')).toBeUndefined()
      expect(savedLaunch('codex-twin')).toMatchObject({ lifecycle: 'failed' })
    }
  )
})

describe('folder catalogs settling over many held launches', () => {
  type Work = {
    rowReads: number
    catalogBuilds: number
    tabProbes: number
    draws: number
    storageWrites: number
    rpc: number
  }

  /** `count` held launches, each in its own env-1 folder among as many unrelated ones; counts
   *  what `settle` does after a first catalog has drawn them all. */
  async function settleCost(count: number, settle: () => Promise<void>): Promise<Work> {
    main.close()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    useAppStore.setState({
      folderWorkspaces: [],
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      tabsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {}
    })
    main = await drawTabsFromMain(useAppStore)
    const repo = useAppStore.getState().repos[0]!
    useAppStore.setState({ repos: [{ ...repo, executionHostId: 'runtime:env-1' }] })
    const ids = Array.from({ length: count }, (_, index) => `folder-${count}-${index}`)
    await reloadWithUnreadablePartition(ids.map((id) => heldRow(`codex-${id}`, id)))
    hostFolders({
      'env-1': [...ids, ...ids.map((id) => `${id}-unrelated`)].map(folder),
      'env-2': []
    })
    await loadAllHostFolders()
    for (const id of ids) {
      expect(chatTabs(`codex-${id}`, folderWorkspaceKey(id))).toHaveLength(1)
    }
    const work: Work = {
      rowReads: 0,
      catalogBuilds: 0,
      tabProbes: 0,
      draws: 0,
      storageWrites: 0,
      rpc: 0
    }
    const counted = <T extends object>(entry: T, key: keyof T, count: () => void): void => {
      const value = entry[key]
      Object.defineProperty(entry, key, {
        configurable: true,
        enumerable: true,
        get: () => (count(), value)
      })
    }
    for (const record of readStructuredAgentLaunchRecords()) {
      counted(record, 'surfaceAddress', () => work.rowReads++)
    }
    const state = useAppStore.getState()
    for (const tab of Object.values(state.unifiedTabsByWorktree).flat()) {
      counted(tab, 'entityId', () => work.tabProbes++)
    }
    const { allWorktrees, createUnifiedTab } = state
    useAppStore.setState({
      allWorktrees: () => (work.catalogBuilds++, allWorktrees()),
      createUnifiedTab: (...args) => (work.draws++, createUnifiedTab(...args))
    })
    const writes = [vi.spyOn(localStorage, 'setItem'), vi.spyOn(localStorage, 'removeItem')]
    const rpcBefore = mocks.rpc.length
    try {
      await settle()
      work.storageWrites = writes
        .flatMap((spy) => spy.mock.calls)
        .filter(([key]) => key.startsWith('orca:structuredAgentLaunch')).length
    } finally {
      writes.forEach((spy) => spy.mockRestore())
      useAppStore.setState({ allWorktrees, createUnifiedTab })
    }
    work.rpc = mocks.rpc
      .slice(rpcBefore)
      .filter((method) => method !== 'folderWorkspace.list').length
    return work
  }

  it('does nothing for drawn chats as the same catalog settles again', async () => {
    const small = await settleCost(3, refreshHostFolders)
    const large = await settleCost(30, refreshHostFolders)
    for (const work of [small, large]) {
      expect(work).toMatchObject({ catalogBuilds: 0, draws: 0, storageWrites: 0, rpc: 0 })
    }
    // Each saved row and tab read a bounded number of times: linear, never rows times tabs.
    expect(large.rowReads).toBeLessThanOrEqual(2 * 30)
    expect(large.tabProbes).toBeLessThanOrEqual(2 * 30)
  })

  it('leaves the folder launches unvisited as unrelated repo listings settle', async () => {
    const listings = (count: number) => async () => {
      for (let index = 0; index < count; index++) {
        listRepo([{ ...worktree, hostId: 'runtime:env-1' }])
      }
      await settled()
    }
    const small = await settleCost(3, listings(3))
    const large = await settleCost(30, listings(30))
    for (const work of [small, large]) {
      expect(work).toMatchObject({
        rowReads: 0,
        catalogBuilds: 0,
        draws: 0,
        storageWrites: 0,
        rpc: 0
      })
    }
  })
})
