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
  resetStructuredAgentLaunchPersistenceForTests
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
function hostReplies(status: () => Promise<unknown>): void {
  mocks.hostLaunch.mockImplementation(async (method) =>
    method === 'agent.launchAccept' ? { state: 'running' } : status()
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
  const terminalAnswer = (outcome: 'handed-to-terminal' | 'not-delivered') => ({
    state: 'succeeded',
    result: {
      outcome: {
        kind: 'terminal',
        handle: 'term_1',
        paneKey: `${TERMINAL_TAB}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`
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

  /** Restores `count` held launches through settled layout, counting full journal writes, rows
   *  they serialize, and every read of a row's address (the scans that place slots). */
  async function restoreCost(count: number): Promise<Cost> {
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    const prefix = `codex-batch-${count}`
    const rows = Array.from({ length: count }, (_, index) =>
      row(`${prefix}-${index}`, 'local', { hostLaunchOperationId: `host-op-${prefix}-${index}` })
    )
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
      (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).filter((tab) =>
        tab.entityId.startsWith(prefix)
      )
    ).toHaveLength(count)
    return {
      flushes: flushed.length,
      serializedRows: flushed.reduce((sum, [, value]) => sum + JSON.parse(value).length, 0),
      addressReads
    }
  }

  it('writes the journal a constant number of times and reads each row a bounded number of times', async () => {
    const small = await restoreCost(3)
    useAppStore.setState({ unifiedTabsByWorktree: {}, groupsByWorktree: {}, tabsByWorktree: {} })
    const large = await restoreCost(30)

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
      const chat = chatTabs('codex-batch-30-29')[0]!
      expect(savedLaunch('codex-batch-30-29')).toMatchObject({
        surfaceAddress: { targetGroupId: chat.groupId }
      })
    }
  })
})
