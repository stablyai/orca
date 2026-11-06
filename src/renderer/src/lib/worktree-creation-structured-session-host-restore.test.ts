// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import type * as launchModule from './agent-session/launch/structured-agent-session-launch-create-call'
import {
  getStructuredAgentSessionLaunchFailure,
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecords,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { retryStructuredAgentSessionLaunch } from './agent-session/launch/structured-agent-session-launch'
import { restoreStructuredLaunchSurfaces } from './agent-session/launch/structured-agent-session-launch-restore'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import { buildWorktreePurgeState } from '@/store/slices/worktrees/teardown/worktree-purge-state'
import { buildRuntimeSessionPlaceholders } from '@/store/terminals/workspace-terminal-placeholders'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>(),
  hostLaunch: vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})),
  // Every method this window asked a host.
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
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) =>
      mocks.rpc.push(args[1]) &&
      (args[1].startsWith('agent.launch') || args[1] === 'agentSession.history')
        ? mocks.hostLaunch(args[1], args[2])
        : client.callRuntimeRpc(...args)
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
const HELD = 'Recover this first message'
let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.rpc.length = 0
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  mocks.createSession.mockReturnValue(new Promise(() => {}))
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  localStorage.removeItem(LAUNCHES)
  useAppStore.setState(initialState, true)
})

const acceptCalls = (): Record<string, unknown>[] =>
  mocks.hostLaunch.mock.calls
    .filter(([method]) => method === 'agent.launchAccept')
    .map(([, params]) => params as Record<string, unknown>)
const savedLaunch = (sessionId: string): Record<string, unknown> | undefined =>
  (JSON.parse(localStorage.getItem(LAUNCHES) ?? '[]') as Record<string, unknown>[]).find(
    (row) => row.sessionId === sessionId
  )
const chatTabs = (sessionId: string) =>
  (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).filter(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
const lifecycleOf = (sessionId: string) =>
  getStructuredAgentSessionLaunchLifecycle(worktree.id, sessionId)
const sessionDraft = (sessionId: string): string =>
  readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(sessionId)).text

/** The host's answers: each status read gives `status()`. */
function hostReplies(status: (params: { operationId?: string }) => Promise<unknown>): void {
  mocks.hostLaunch.mockImplementation(async (method, params) =>
    method === 'agent.launchAccept'
      ? { state: 'running' }
      : status(params as { operationId?: string })
  )
}

/** A saved launch row as this window writes it. */
const row = (sessionId: string, executionHostId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  executionHostId,
  agent: 'codex',
  lifecycle: 'failed',
  clientOperationId: `op-${sessionId}`,
  payloadFingerprint: 'fingerprint',
  expectedRuntimeFence: null,
  surfaceAddress: { worktreeId: worktree.id, precedingTabIds: [] },
  ...extra
})

describe('restoring held host launches at startup', () => {
  it('draws a paired launch only on the host it ran on, and no ordinary failed launch', async () => {
    // The workspace is the paired server's, as its catalog says.
    useAppStore.setState({
      worktreesByRepo: { [worktree.repoId]: [{ ...worktree, runtimeOwnerEnvironmentId: 'env-1' }] }
    })
    localStorage.setItem(
      LAUNCHES,
      JSON.stringify([
        row('codex-owned', 'runtime:env-1', { hostLaunchOperationId: 'host-op-1' }),
        row('codex-elsewhere', 'runtime:env-2', { hostLaunchOperationId: 'host-op-2' }),
        row('codex-here', 'local', { hostLaunchOperationId: 'host-op-3' }),
        row('codex-ordinary', 'runtime:env-1')
      ])
    )
    resetStructuredAgentLaunchPersistenceForTests()

    restoreStructuredLaunchSurfaces()
    await main.settle()
    expect(chatTabs('codex-owned')).toMatchObject([{ executionHostId: 'runtime:env-1' }])
    for (const sessionId of ['codex-elsewhere', 'codex-here', 'codex-ordinary']) {
      expect(chatTabs(sessionId)).toEqual([])
      // Not shown here, never retired: its own host can still show it.
      expect(savedLaunch(sessionId)).toBeDefined()
    }
    expect(mocks.rpc).toEqual([])
  })

  const TERMINAL_TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
  const terminalAnswer = (
    outcome: 'handed-to-terminal' | 'not-delivered',
    terminalTab: string | null = TERMINAL_TAB
  ) => ({
    state: 'succeeded',
    result: {
      outcome: {
        kind: 'terminal',
        handle: 'term_1',
        // A terminal result may name no pane: the chat cannot find it then.
        ...(terminalTab ? { paneKey: `${terminalTab}:3f2504e0-4f89-41d3-9a0c-0305e82c3301` } : {})
      },
      worktreeId: worktree.id,
      receipt: {
        mode: 'terminal',
        preferred: 'structured',
        reason: 'structured_unsupported_on_host',
        detail: ''
      },
      prompt: { delivery: 'submit', outcome }
    }
  })

  it.each([
    ['handed the held message to it', 'handed-to-terminal', false],
    ['did not deliver the held message', 'not-delivered', true]
  ] as const)(
    "puts the host's terminal in a restored chat's place once it %s",
    async (_case, outcome, chatStays) => {
      // A launch from before the reload, with no saved tab: its row holds the message.
      localStorage.setItem(
        LAUNCHES,
        JSON.stringify([
          row('codex-restored', 'local', {
            lifecycle: 'pending',
            hostLaunchOperationId: 'host-op-1',
            firstMessage: {
              clientMessageId: 'held-message',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: HELD }] }
            }
          })
        ])
      )
      resetStructuredAgentLaunchPersistenceForTests()
      restoreStructuredLaunchSurfaces()
      await main.settle()
      expect(chatTabs('codex-restored')).toHaveLength(1)

      // The host's terminal reaches this window; its record says that is what it started.
      useAppStore.getState().createTab(worktree.id, undefined, undefined, { id: TERMINAL_TAB })
      hostReplies(async () => terminalAnswer(outcome))
      expect(retryStructuredAgentSessionLaunch(worktree.id, 'codex-restored')).toBe(true)

      const tabIds = () =>
        (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)
      if (chatStays) {
        // The text is still the user's: the chat holds it right beside the terminal.
        await vi.waitFor(() => expect(sessionDraft('codex-restored')).toBe(HELD))
        await vi.waitFor(() =>
          expect(getStructuredAgentSessionLaunchFailure(worktree.id, 'codex-restored')).toEqual(
            expect.objectContaining({ code: 'structured_agent_session_unsupported' })
          )
        )
        await main.settle()
        const chat = chatTabs('codex-restored')[0]!
        const order = useAppStore
          .getState()
          .groupsByWorktree[worktree.id]?.find((group) => group.id === chat.groupId)?.tabOrder
        expect(order?.indexOf(TERMINAL_TAB)).toBe((order?.indexOf(chat.id) ?? -2) + 1)
        expect(savedLaunch('codex-restored')).toMatchObject({ lifecycle: 'failed' })
      } else {
        await vi.waitFor(() => expect(chatTabs('codex-restored')).toEqual([]))
        await main.settle()
        expect(tabIds()).toContain(TERMINAL_TAB)
        expect(savedLaunch('codex-restored')).toBeUndefined()
        // Closed as any chat is: a window-owned build keeps its usual close tombstone.
        expect(lifecycleOf('codex-restored')).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? null : 'cancelled')
      }
      // Only read: nothing accepted, created, sent or typed into a terminal again.
      expect(acceptCalls()).toEqual([])
      expect(mocks.createSession).not.toHaveBeenCalled()
      expect(mocks.rpc).not.toContain('agentSession.create')
      expect(mocks.rpc).not.toContain('agentSession.send')
      expect(useAppStore.getState().pendingStartupByTabId).toEqual({})
      expect(useAppStore.getState().tabsByWorktree[worktree.id]?.map((tab) => tab.id)).toEqual([
        TERMINAL_TAB
      ])
    }
  )

  it.each([
    ['its host lists the workspace no more', true],
    ['its host cannot be read', false]
  ] as const)(
    'retires a paired launch whose chat never showed only when %s',
    async (_case, hostListed) => {
      useAppStore.setState({
        worktreesByRepo: {
          [worktree.repoId]: [{ ...worktree, runtimeOwnerEnvironmentId: 'env-1' }]
        }
      })
      localStorage.setItem(
        LAUNCHES,
        JSON.stringify([row('codex-paired', 'runtime:env-1', { hostLaunchOperationId: 'host-op' })])
      )
      // After a reload, before anything drew its chat.
      resetStructuredAgentLaunchPersistenceForTests()
      if (hostListed) {
        // The host's own listing, as its refresh applies one that dropped the workspace.
        const state = useAppStore.getState()
        useAppStore.setState(
          buildWorktreePurgeState(state, [
            hostWorktreeTarget({ id: worktree.id, hostId: 'runtime:env-1' })
          ])
        )
        expect(savedLaunch('codex-paired')).toBeUndefined()
        restoreStructuredLaunchSurfaces()
        await main.settle()
        expect(chatTabs('codex-paired')).toEqual([])
      } else {
        // No listing came: nothing proves the workspace gone, so the launch still shows.
        restoreStructuredLaunchSurfaces()
        await main.settle()
        expect(savedLaunch('codex-paired')).toBeDefined()
        expect(chatTabs('codex-paired')).toHaveLength(1)
      }
      expect(mocks.rpc).toEqual([])
    }
  )

  const heldRow = (sessionId: string, host: string) =>
    row(sessionId, host, {
      hostLaunchOperationId: `host-op-${sessionId}`,
      firstMessage: {
        clientMessageId: 'held-message',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: HELD }] }
      }
    })

  /** This window's cached partition for runtime:env-1 at startup, holding the workspace's Setup. */
  async function startupSessionRead(readable: boolean) {
    const setup = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktree.id]: [
          {
            id: 'setup-terminal',
            ptyId: null,
            worktreeId: worktree.id,
            title: 'Setup',
            customTitle: 'Setup',
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
        {
          get: async (hostId) => {
            if (!hostId) {
              return getDefaultWorkspaceSession()
            }
            if (!readable) {
              throw new Error('partition unreadable')
            }
            return setup
          }
        },
        [],
        ['runtime:env-1']
      )
      const owners = read.runtimeHostIdByWorkspaceSessionKey
      useAppStore.setState({
        restoredRuntimeHostIdByWorkspaceSessionKey: owners,
        worktreesByRepo: buildRuntimeSessionPlaceholders({
          repos: [],
          runtimeHostIdByWorkspaceSessionKey: owners,
          worktreesByRepo: {}
        }).worktreesByRepo
      })
    } finally {
      warn.mockRestore()
    }
  }

  /** A paired host's listing of the repo, applied by the store's own catalog writer. */
  function listFrom(environmentId: string, rows: Worktree[]): void {
    const hostId = `runtime:${environmentId}` as const
    const outcome = mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
      repoId: worktree.repoId,
      hostId,
      ownerWasMissingAtStart: false,
      requestStartedWorktrees: useAppStore.getState().worktreesByRepo[worktree.repoId],
      refresh: {
        status: 'admitted',
        executionHostId: hostId,
        result: {
          repoId: worktree.repoId,
          authoritative: true,
          // Not a git scan: this window keeps no saved metadata to forget for its removals.
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

  function pairWithHosts(): void {
    const repo = useAppStore.getState().repos[0]!
    useAppStore.setState({
      repos: ['env-1', 'env-2'].map((id) => ({ ...repo, executionHostId: `runtime:${id}` }))
    })
  }

  it('draws a paired launch from a readable cached Setup partition at startup', async () => {
    localStorage.setItem(LAUNCHES, JSON.stringify([heldRow('codex-setup-cached', 'runtime:env-1')]))
    resetStructuredAgentLaunchPersistenceForTests()
    await startupSessionRead(true)
    expect(
      useAppStore.getState().worktreesByRepo[worktree.repoId]?.map((entry) => entry.id)
    ).toEqual([worktree.id])

    restoreStructuredLaunchSurfaces()
    await main.settle()
    expect(chatTabs('codex-setup-cached')).toMatchObject([{ executionHostId: 'runtime:env-1' }])
    expect(mocks.rpc).toEqual([])
  })

  it('draws it once its own host lists the workspace when the startup read failed', async () => {
    pairWithHosts()
    localStorage.setItem(LAUNCHES, JSON.stringify([heldRow('codex-listed-late', 'runtime:env-1')]))
    resetStructuredAgentLaunchPersistenceForTests()
    await startupSessionRead(false)
    expect(useAppStore.getState().worktreesByRepo).toEqual({})
    restoreStructuredLaunchSurfaces()
    await main.settle()
    expect(chatTabs('codex-listed-late')).toEqual([])

    // Another host listing the same workspace, then dropping it, neither shows nor ends it.
    listFrom('env-2', [{ ...worktree, hostId: 'runtime:env-2' }])
    await vi.dynamicImportSettled()
    await main.settle()
    expect(chatTabs('codex-listed-late')).toEqual([])
    listFrom('env-2', [])
    await vi.dynamicImportSettled()
    await main.settle()
    expect(useAppStore.getState().worktreesByRepo[worktree.repoId]).toEqual([])
    expect(chatTabs('codex-listed-late')).toEqual([])
    expect(savedLaunch('codex-listed-late')).toMatchObject({ lifecycle: 'failed' })

    // Its own host's listing brings it back, once however often the listing settles.
    listFrom('env-1', [{ ...worktree, hostId: 'runtime:env-1' }])
    await vi.dynamicImportSettled()
    await main.settle()
    expect(chatTabs('codex-listed-late')).toHaveLength(1)
    listFrom('env-1', [{ ...worktree, hostId: 'runtime:env-1' }])
    await vi.dynamicImportSettled()
    await main.settle()
    expect(chatTabs('codex-listed-late')).toMatchObject([{ executionHostId: 'runtime:env-1' }])
    expect(lifecycleOf('codex-listed-late')).toBe('failed')
    expect(savedLaunch('codex-listed-late')).toMatchObject({
      firstMessage: { clientMessageId: 'held-message' }
    })
    // Only drawn: nothing was accepted, read, created or sent.
    expect(mocks.rpc.filter((method) => /^agent(Session)?\./.test(method))).toEqual([])
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it("ends a removed host's launches whose workspace never loaded, and only that host's", () => {
    localStorage.setItem(
      LAUNCHES,
      JSON.stringify([
        heldRow('codex-removed', 'runtime:env-1'),
        heldRow('codex-other', 'runtime:env-2')
      ])
    )
    resetStructuredAgentLaunchPersistenceForTests()
    // No listing or session ever loaded the workspace here.
    useAppStore.setState({ worktreesByRepo: {}, restoredRuntimeHostIdByWorkspaceSessionKey: {} })
    useAppStore.getState().purgeStaleRuntimeHostState(['env-1'])
    expect(savedLaunch('codex-removed')).toBeUndefined()
    expect(savedLaunch('codex-other')).toBeDefined()
  })
})

describe('restoring many held launches at once', () => {
  type Cost = { flushes: number; serializedRows: number; addressReads: number }
  type Spread = 'one failed workspace' | 'pending across workspaces'

  const launchedIn = (spread: Spread, count: number, index: number): string =>
    spread === 'one failed workspace' ? worktree.id : `${worktree.id}-${count}-${index}`

  /** Restores `count` held launches through settled layout, counting full journal writes, rows
   *  they serialize, and every read of a row's address (the scans that place slots). */
  async function restoreCost(spread: Spread, count: number): Promise<Cost> {
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    useAppStore.setState({ unifiedTabsByWorktree: {}, groupsByWorktree: {}, tabsByWorktree: {} })
    const prefix = `codex-batch-${count}`
    const rows = Array.from({ length: count }, (_, index) =>
      row(`${prefix}-${index}`, 'local', {
        hostLaunchOperationId: `host-op-${prefix}-${index}`,
        surfaceAddress: { worktreeId: launchedIn(spread, count, index), precedingTabIds: [] },
        // A pending row is still a reserved slot; a failed one is not.
        ...(spread === 'one failed workspace' ? {} : { lifecycle: 'pending' })
      })
    )
    if (spread === 'pending across workspaces') {
      useAppStore.setState({
        worktreesByRepo: {
          [worktree.repoId]: rows.map((_, index) => ({
            ...worktree,
            id: launchedIn(spread, count, index)
          }))
        }
      })
    }
    localStorage.setItem(LAUNCHES, JSON.stringify(rows))
    let addressReads = 0
    for (const record of readStructuredAgentLaunchRecords()) {
      const address = record.surfaceAddress
      Object.defineProperty(record, 'surfaceAddress', {
        enumerable: true,
        get: () => (addressReads++, address)
      })
    }
    const writes = vi.spyOn(localStorage, 'setItem')
    restoreStructuredLaunchSurfaces()
    await main.settle()
    const flushed = writes.mock.calls.filter(([key]) => key === LAUNCHES)
    writes.mockRestore()
    expect(
      Object.values(useAppStore.getState().unifiedTabsByWorktree)
        .flat()
        .filter((tab) => tab.entityId.startsWith(prefix))
    ).toHaveLength(count)
    return {
      flushes: flushed.length,
      serializedRows: flushed.reduce((sum, [, value]) => sum + JSON.parse(value).length, 0),
      addressReads
    }
  }

  it.each(['one failed workspace', 'pending across workspaces'] as const)(
    'writes the journal a constant number of times and reads each row a bounded number of times (%s)',
    async (spread) => {
      const small = await restoreCost(spread, 3)
      const large = await restoreCost(spread, 30)

      // One batch, one write at most: a main-drawn chat's slot moves into its group once.
      expect(large.flushes).toBe(small.flushes)
      expect(large.flushes).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 1 : 0)
      expect(large.serializedRows).toBe(large.flushes * 30)
      // Linear in the rows: ten times the rows costs at most ten times the reads.
      expect(large.addressReads).toBeLessThanOrEqual(10 * small.addressReads)

      // Restoring again changes no address, so nothing is written.
      const writes = vi.spyOn(localStorage, 'setItem')
      restoreStructuredLaunchSurfaces()
      await main.settle()
      expect(writes.mock.calls.filter(([key]) => key === LAUNCHES)).toEqual([])
      writes.mockRestore()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // The one write is a real move: each row now names the group its chat was drawn in.
        const chat = Object.values(useAppStore.getState().unifiedTabsByWorktree)
          .flat()
          .find((tab) => tab.entityId === 'codex-batch-30-29')!
        expect(savedLaunch('codex-batch-30-29')).toMatchObject({
          surfaceAddress: { targetGroupId: chat.groupId }
        })
      }
    }
  )
})

describe('a listing settling over launches whose chats already show', () => {
  type Work = {
    rowReads: number
    catalogBuilds: number
    tabProbes: number
    orderVisits: number
    draws: number
    storageWrites: number
    storageBytes: number
    rpc: number
  }
  const OTHER_REPO = 'repo-2'

  /** This window's own host listing a repo, applied by the store's own catalog writer. */
  function listLocal(repoId: string, rows: Worktree[]): void {
    const outcome = mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
      repoId,
      hostId: 'local',
      ownerWasMissingAtStart: false,
      requestStartedWorktrees: useAppStore.getState().worktreesByRepo[repoId],
      refresh: {
        status: 'admitted',
        executionHostId: 'local',
        result: {
          repoId,
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

  const otherRepoRow = (index: number): Worktree => ({
    ...worktree,
    id: `${OTHER_REPO}::/workspace/other-${index}`,
    repoId: OTHER_REPO,
    path: `/workspace/other-${index}`
  })
  const shownTabs = () =>
    (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).filter((tab) =>
      tab.entityId.startsWith('codex-shown-')
    )

  /** Restores `count` failed host launches in one workspace, then counts the work the given
   *  listings do once settled: every saved row, tab and group order read, catalog built, tab
   *  drawn or slot reserved, journal saved or removed, and host request. */
  async function settleCost(count: number, settle: () => void): Promise<Work> {
    main.close()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    seedEmptyActivatableWorktree(worktree)
    const repo = useAppStore.getState().repos[0]!
    useAppStore.setState({
      repos: [repo, { ...repo, id: OTHER_REPO }],
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      tabsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {}
    })
    main = await drawTabsFromMain(useAppStore)
    localStorage.setItem(
      LAUNCHES,
      JSON.stringify(
        Array.from({ length: count }, (_, index) =>
          row(`codex-shown-${count}-${index}`, 'local', {
            hostLaunchOperationId: `host-op-shown-${count}-${index}`
          })
        )
      )
    )
    restoreStructuredLaunchSurfaces()
    await main.settle()
    expect(shownTabs()).toHaveLength(count)

    const work: Work = {
      rowReads: 0,
      catalogBuilds: 0,
      tabProbes: 0,
      orderVisits: 0,
      draws: 0,
      storageWrites: 0,
      storageBytes: 0,
      rpc: mocks.rpc.length
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
      counted(tab, 'id', () => work.tabProbes++)
      counted(tab, 'entityId', () => work.tabProbes++)
    }
    for (const group of Object.values(state.groupsByWorktree).flat()) {
      counted(group, 'tabOrder', () => work.orderVisits++)
    }
    const { allWorktrees, createUnifiedTab, ensureWorktreeRootGroup } = state
    useAppStore.setState({
      allWorktrees: () => (work.catalogBuilds++, allWorktrees()),
      createUnifiedTab: (...args) => (work.draws++, createUnifiedTab(...args)),
      ensureWorktreeRootGroup: (...args) => (work.draws++, ensureWorktreeRootGroup(...args))
    })
    const storage = [vi.spyOn(localStorage, 'setItem'), vi.spyOn(localStorage, 'removeItem')]
    try {
      settle()
      await vi.dynamicImportSettled()
      await main.settle()
      for (const spy of storage) {
        for (const [key, value] of spy.mock.calls) {
          if (key === LAUNCHES || key.startsWith('orca:structuredAgentLaunch')) {
            work.storageWrites++
            work.storageBytes += typeof value === 'string' ? value.length : 0
          }
        }
      }
    } finally {
      storage.forEach((spy) => spy.mockRestore())
      useAppStore.setState({ allWorktrees, createUnifiedTab, ensureWorktreeRootGroup })
    }
    work.rpc = mocks.rpc.length - work.rpc
    expect(shownTabs()).toHaveLength(count)
    return work
  }

  it('does no work for chats already shown, however many there are', async () => {
    const small = await settleCost(3, () => listLocal(worktree.repoId, [worktree]))
    const large = await settleCost(30, () => listLocal(worktree.repoId, [worktree]))
    for (const work of [small, large]) {
      // Nothing to draw: no catalog, slot, tab, save or host request.
      expect(work).toMatchObject({
        catalogBuilds: 0,
        orderVisits: 0,
        draws: 0,
        storageWrites: 0,
        storageBytes: 0,
        rpc: 0
      })
    }
    // Each saved row and shown tab read a bounded number of times: linear, not rows times tabs.
    expect(large.rowReads).toBeLessThanOrEqual(10 * small.rowReads)
    expect(large.tabProbes).toBeLessThanOrEqual(10 * small.tabProbes)
    expect(large.tabProbes).toBeLessThanOrEqual(2 * 30)
  })

  it('leaves the saved launches unvisited when other repos settle', async () => {
    // Each settlement adds a workspace to another repo and removes none.
    const unrelated = (count: number) => () => {
      const rows: Worktree[] = []
      for (let index = 0; index < count; index++) {
        rows.push(otherRepoRow(index))
        listLocal(OTHER_REPO, rows)
      }
    }
    const small = await settleCost(3, unrelated(3))
    const large = await settleCost(30, unrelated(30))
    for (const work of [small, large]) {
      expect(work).toMatchObject({ draws: 0, storageWrites: 0, rpc: 0 })
    }
    // Ten times the settlements over ten times the launches: the saved rows are indexed once
    // (twice at most), never read again per settlement.
    expect(large.rowReads).toBeLessThanOrEqual(2 * 30)
    expect(large.tabProbes).toBeLessThanOrEqual(2 * 30)
  })

  it('still draws a chat that is not showing: a lost tab, and a launch saved since', async () => {
    let lost = ''
    const work = await settleCost(3, () => {
      // The tab went away without its launch ending. Main draws the tabs it owns, so only a
      // window-owned list can lose one here.
      lost = shownTabs()[0]!.entityId
      if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
        useAppStore.setState((state) => ({
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktree.id]: state.unifiedTabsByWorktree[worktree.id]!.filter(
              (tab) => tab.entityId !== lost
            )
          }
        }))
      }
      listLocal(worktree.repoId, [worktree])
    })
    // Only the lost chat is drawn again: its slot and its tab.
    expect(work.draws).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 0 : 2)
    expect(chatTabs(lost)).toHaveLength(1)
    // A launch saved after the reload is drawn by the next listing, beside the shown ones.
    writeStructuredAgentLaunchRecord(
      row('codex-shown-later', 'local', { hostLaunchOperationId: 'host-op-later' }) as never
    )
    listLocal(worktree.repoId, [worktree])
    await vi.dynamicImportSettled()
    await main.settle()
    expect(chatTabs('codex-shown-later')).toHaveLength(1)
    expect(chatTabs(lost)).toHaveLength(1)
    expect(mocks.rpc.filter((method) => /^agent(Session)?\./.test(method))).toEqual([])
  })
})
