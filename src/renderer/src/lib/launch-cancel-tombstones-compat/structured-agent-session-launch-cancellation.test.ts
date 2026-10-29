// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchSlotOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-slot'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { suppressCancelledStructuredSessionTabs } from '@/runtime/structured-agent-session-tab-retirement'
import type { StructuredLaunchState } from '../agent-session/launch/structured-agent-session-launch-registry'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireAbsentStructuredAgentSessionLaunchCancellationTombstones,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '../agent-session/launch/structured-agent-session-launch-registry'
import { beginStructuredAgentSessionAuthoritativeInventory } from './structured-agent-session-launch-cancellation'
import { resetStructuredAgentLaunchPersistenceForTests } from '../agent-session/launch/structured-agent-session-launch-persistence'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { makeWorktree } from '@/store/slices/store-test-helpers'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const layoutOwner: StructuredLaunchSlotOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: vi.fn()
}

const WORKTREE_ID = 'repo-1::worktree-1'
const SESSION_ID = 'session-close-race'
// Paired hosts always need window tombstones; layout-owner local builds use main’s cancel fence instead.
const SERVER_HOST = 'runtime:server-1'
const SERVER = { kind: 'environment', environmentId: 'server-1' } as const

function latePublication(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-late',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `agent-session:${SESSION_ID}`,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION_ID}`,
        title: 'Codex Chat',
        sessionId: SESSION_ID,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function setLaunch(
  executionHostId: ExecutionHostId,
  target: RuntimeClientTarget,
  promise: Promise<{ sessionId: string; fence: number }>,
  operation = 'close-race'
): void {
  setStructuredLaunchState({
    identity: `codex:${WORKTREE_ID}`,
    intent: {
      worktreeId: WORKTREE_ID,
      executionHostId,
      target,
      sessionId: SESSION_ID,
      agent: 'codex',
      params: {
        envelope: {
          sessionId: SESSION_ID,
          clientOperationId: `operation-${operation}`,
          expectedRuntimeFence: null,
          payloadFingerprint: `fingerprint-${operation}`
        },
        worktree: `id:${WORKTREE_ID}`,
        agent: 'codex'
      }
    },
    promptDelivery: 'auto-submit',
    callers: {
      outcome: 'pending',
      attempt: { kind: 'first', requestId: 'plus-pick', stagedPrompt: null },
      entries: new Set(),
      promptDeliveryResults: new Set(),
      onSettled: () => undefined
    },
    promise,
    visibilityUnknown: false,
    cancelled: false,
    selection: { held: {} }
  } satisfies StructuredLaunchState)
}

/** The cancelled launch's late publication stays hidden until the launch settles, on `host`. */
async function expectLatePublicationSuppressed(
  host: ExecutionHostId,
  target: RuntimeClientTarget
): Promise<void> {
  let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
  setLaunch(
    host,
    target,
    new Promise((resolve) => {
      resolveLaunch = resolve
    })
  )
  const beforeCancel = beginStructuredAgentSessionAuthoritativeInventory()
  expect(
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), beforeCancel, host)
  ).toBe(false)
  markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, host, layoutOwner)
  const afterCancel = beginStructuredAgentSessionAuthoritativeInventory()
  expect(
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), afterCancel, host)
  ).toBe(false)
  expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

  resolveLaunch({ sessionId: SESSION_ID, fence: 1 })
  await Promise.resolve()
  expect(suppressCancelledStructuredSessionTabs(latePublication(), target).tabs).toEqual([])
  expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)
  expect(
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), beforeCancel, host)
  ).toBe(false)

  const afterSettlement = beginStructuredAgentSessionAuthoritativeInventory()
  expect(
    retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), afterSettlement, host)
  ).toBe(true)
  expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(false)
}

const TERMINAL = 'terminal-1'
let main: TabsDrawnFromMain | null = null

async function drawWorktreeFromMain(): Promise<void> {
  useAppStore.setState({
    worktreesByRepo: { 'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1' })] },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TERMINAL,
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TERMINAL,
          entityId: TERMINAL,
          groupId: 'group-1',
          worktreeId: WORKTREE_ID,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: TERMINAL, tabOrder: [TERMINAL] }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
    layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-1' } }
  })
  main = await drawTabsFromMain(useAppStore)
}

async function shownChat(): Promise<{ drawn: boolean; inMain: boolean; opened: boolean }> {
  await main?.settle()
  return {
    drawn: (useAppStore.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).some(
      (tab) => tab.entityId === SESSION_ID
    ),
    inMain: (layoutApplyTestTransport.mainModel?.workspaces[WORKTREE_ID]?.tabs ?? []).some(
      (tab) => tab.entityId === SESSION_ID
    ),
    opened: layoutApplyTestTransport
      .sentOfType('openAgentSessionTab')
      .some((command) => command.sessionId === SESSION_ID)
  }
}

const NOT_SHOWN = { drawn: false, inMain: false, opened: false }

afterEach(() => {
  main?.close()
  main = null
})

describe('structured launch cancellation retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn().mockResolvedValue({ ok: true, result: {} })
        }
      }
    })
  })

  it('keeps a paired server’s late publication suppressed until the cancelled launch settles', async () => {
    await expectLatePublicationSuppressed(SERVER_HOST, SERVER)
  })

  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'keeps a late publication suppressed until the cancelled launch settles',
    async () => {
      await expectLatePublicationSuppressed('local', { kind: 'local' })
    }
  )

  // A runtime refused its chats answers with no chat rows; that absence is not the host's answer.
  // Switch on, this machine keeps no tombstone: main's fence is in its close-before-create test.
  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'keeps a tombstone through an inventory that cannot list chats',
    async () => {
      setStructuredLaunchState({
        identity: `codex:${WORKTREE_ID}`,
        intent: {
          worktreeId: WORKTREE_ID,
          executionHostId: 'local',
          target: { kind: 'local' },
          sessionId: SESSION_ID,
          agent: 'codex',
          params: {
            envelope: {
              sessionId: SESSION_ID,
              clientOperationId: 'operation-unverifiable',
              expectedRuntimeFence: null,
              payloadFingerprint: 'fingerprint-unverifiable'
            },
            worktree: `id:${WORKTREE_ID}`,
            agent: 'codex'
          }
        },
        promptDelivery: 'auto-submit',
        callers: {
          outcome: 'pending',
          attempt: { kind: 'first', requestId: 'plus-pick', stagedPrompt: null },
          entries: new Set(),
          promptDeliveryResults: new Set(),
          onSettled: () => undefined
        },
        promise: Promise.resolve({ sessionId: SESSION_ID, fence: 1 }),
        visibilityUnknown: false,
        cancelled: false,
        selection: { held: {} }
      } satisfies StructuredLaunchState)
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const frame = (unverifiable: boolean): RuntimeMobileSessionTabsResult => ({
        ...latePublication(),
        activeTabId: null,
        activeTabType: null,
        tabs: [],
        ...(unverifiable ? { agentSessionsUnverifiable: true as const } : {})
      })
      const call = vi.fn()
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })

      call.mockResolvedValue({
        ok: true,
        result: { snapshots: [frame(true)], authoritative: true }
      })
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        true
      )

      call.mockResolvedValue({
        ok: true,
        result: { snapshots: [frame(false)], authoritative: true }
      })
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
    }
  )

  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'drains a restored cancellation before a newer inventory retires it',
    async () => {
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()

      const close = Promise.withResolvers<void>()
      const call = vi.fn(({ method }: { method: string }) => {
        if (method === 'agentSession.close') {
          return close.promise.then(() => ({ ok: true, result: { ok: true } }))
        }
        return Promise.resolve({ ok: true, result: { snapshots: [], authoritative: true } })
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { runtime: { call } }
      })

      await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })

      expect(call.mock.calls.map(([request]) => request.method)).toEqual([
        'agentSession.close',
        'session.tabs.listAll'
      ])
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        true
      )

      // The close shares the host's session lane with create, so settlement drains a late attach.
      close.resolve()
      await close.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      await refreshLocalStructuredSessionTabs()

      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
      expect(
        call.mock.calls.filter(([request]) => request.method === 'agentSession.close')
      ).toHaveLength(1)
    }
  )

  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'keeps a local cancel through an inventory that cannot list chats',
    async () => {
      await drawWorktreeFromMain()
      setLaunch('local', { kind: 'local' }, Promise.resolve({ sessionId: SESSION_ID, fence: 1 }))
      const call = vi.fn((_request: { method: string }): Promise<unknown> =>
        Promise.resolve({ ok: true, result: { ok: true } })
      )
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const closes = () =>
        call.mock.calls.filter(([request]) => request.method === 'agentSession.close')
      expect(closes()).toHaveLength(1)

      const listing = (unverifiable: boolean) => ({
        ok: true,
        result: {
          snapshots: [
            unverifiable
              ? { ...latePublication(), tabs: [], agentSessionsUnverifiable: true as const }
              : latePublication()
          ],
          authoritative: true
        }
      })
      call.mockImplementation(() => Promise.resolve(listing(true)))
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
      expect(await shownChat()).toEqual(NOT_SHOWN)

      call.mockImplementation(() => Promise.resolve(listing(false)))
      await refreshLocalStructuredSessionTabs()
      expect(await shownChat()).toEqual(NOT_SHOWN)
      expect(closes()).toHaveLength(1)
    }
  )

  // An older switch-off build saved the tombstone; this build drains it on its first inventory.
  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'drains a tombstone an older build saved: one close, and main shows no chat',
    async () => {
      localStorage.setItem(
        'orca:structuredAgentLaunchCancelledSessions:v1',
        JSON.stringify([SESSION_ID])
      )
      resetStructuredAgentLaunchPersistenceForTests()
      await drawWorktreeFromMain()

      const close = Promise.withResolvers<void>()
      const call = vi.fn(({ method }: { method: string }) => {
        if (method === 'agentSession.close') {
          return close.promise.then(() => ({ ok: true, result: { ok: true } }))
        }
        return Promise.resolve({ ok: true, result: { snapshots: [], authoritative: true } })
      })
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })

      await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })
      expect(call.mock.calls.map(([request]) => request.method)).toEqual([
        'agentSession.close',
        'session.tabs.listAll'
      ])
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        true
      )

      close.resolve()
      await close.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      await refreshLocalStructuredSessionTabs()
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )
      expect(
        call.mock.calls.filter(([request]) => request.method === 'agentSession.close')
      ).toHaveLength(1)
      expect(await shownChat()).toEqual(NOT_SHOWN)
    }
  )

  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'tells main of a local cancel at once, so the next inventory has nothing to drain',
    async () => {
      const call = vi.fn(({ method }: { method: string }) =>
        Promise.resolve(
          method === 'session.tabs.listAll'
            ? { ok: true, result: { snapshots: [], authoritative: true } }
            : { ok: true, result: { ok: true } }
        )
      )
      Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local', layoutOwner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
        false
      )

      await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })
      expect(call.mock.calls.map(([request]) => request.method)).toEqual([
        'agentSession.close',
        'session.tabs.close',
        'session.tabs.listAll'
      ])
    }
  )
})
