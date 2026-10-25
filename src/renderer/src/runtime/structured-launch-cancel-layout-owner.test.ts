// @vitest-environment happy-dom

// Local layout-owner main records cancellation; paired hosts retain tombstones in either build.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StructuredLaunchSlotOwner } from '@/lib/structured-agent-session-launch-slot'

import { useAppStore } from '@/store'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import { acceptSessionTabsRuntimeId } from './web-session-tabs-sync/publisher-identity-fences'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import * as unlisted from '@/lib/structured-agent-session-unlisted-created-chats'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  callRuntime:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>()
}))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: vi.fn()
}))
vi.mock('./structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntime }))
vi.mock('./local-session-tab-close-owner', () => ({
  withLocalSessionTabCloseOwner: async (_w: string, _t: string, close: () => Promise<unknown>) =>
    close()
}))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState,
  type StructuredLaunchState
} from '@/lib/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import { wasStructuredAgentLaunchClosedByLocalCancel } from '@/lib/structured-agent-session-local-launch-cancel'
import {
  beginStructuredAgentSessionTabClose,
  suppressCancelledStructuredSessionTabs
} from './structured-agent-session-tab-retirement'

const WORKTREE = 'repo-1::worktree-1'
const SESSION = 'chat-1'
const LOCAL: RuntimeClientTarget = { kind: 'local' }
const layoutOwner: StructuredLaunchSlotOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: vi.fn()
}
const SERVER: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-1' }
const SERVER_HOST = 'runtime:server-1'

function hostFrame(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION}`,
        title: 'Codex Chat',
        sessionId: SESSION,
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

/** A launch whose create is still on its way to `executionHostId`. */
function pendingLaunch(executionHostId: ExecutionHostId, target: RuntimeClientTarget): void {
  setStructuredLaunchState({
    identity: `codex:${WORKTREE}`,
    intent: {
      worktreeId: WORKTREE,
      executionHostId,
      target,
      sessionId: SESSION,
      agent: 'codex',
      params: {
        envelope: {
          sessionId: SESSION,
          clientOperationId: 'operation-1',
          expectedRuntimeFence: null,
          payloadFingerprint: 'fingerprint-1'
        },
        worktree: `id:${WORKTREE}`,
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
    promise: new Promise(() => undefined),
    visibilityUnknown: false,
    cancelled: false,
    selection: { held: {} }
  } satisfies StructuredLaunchState)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.layoutOwnerIsMain = true
  mocks.closeSession.mockResolvedValue('closed')
  mocks.callRuntime.mockResolvedValue(undefined)
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

describe('this machine, with main owning the layout', () => {
  const hostTabClose = [
    LOCAL,
    'session.tabs.close',
    { worktree: `id:${WORKTREE}`, tabId: `agent-session:${SESSION}`, reason: 'user' }
  ]

  it('cancel before the create: retires the chat on main at once and keeps no tombstone', async () => {
    // The create has not landed, so main has no tab for it yet.
    mocks.callRuntime.mockRejectedValueOnce(new Error('tab_not_found'))
    pendingLaunch('local', LOCAL)

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalledWith(...hostTabClose))

    expect(mocks.closeSession).toHaveBeenCalledWith(LOCAL, SESSION)
    // Let the retirement settle, so a tombstone written on its answer would show.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, SESSION)).toBeNull()
  })

  it('create before the cancel (an aborted launch): closes the chat and its published tab', async () => {
    pendingLaunch('local', LOCAL)

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)

    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalledWith(...hostTabClose))
    expect(mocks.closeSession).toHaveBeenCalledWith(LOCAL, SESSION)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
  })

  it('cancel after a reload, when only the saved launch is left: tells main and forgets it', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: SESSION,
      executionHostId: 'local',
      agent: 'codex',
      lifecycle: 'pending',
      clientOperationId: 'operation-1',
      payloadFingerprint: 'fingerprint-1',
      expectedRuntimeFence: null
    })

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)

    expect(mocks.closeSession).toHaveBeenCalledWith(LOCAL, SESSION)
    expect(readStructuredAgentLaunchRecord(SESSION)).toBeUndefined()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
  })

  // Main records close before fallible work, fencing late creates without publishing a chat (structured-agent-session-close-before-create.test.ts).
  it('a retire main fails is logged; no tombstone, and a late create reply revives nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.closeSession.mockRejectedValueOnce(new Error('host unavailable'))
    pendingLaunch('local', LOCAL)

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[structured-agent-session] local cancel retirement failed',
        expect.any(Error)
      )
    )

    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
    expect(wasStructuredAgentLaunchClosedByLocalCancel(SESSION)).toBe(true)
    expect(suppressCancelledStructuredSessionTabs(hostFrame(), LOCAL).tabs).toHaveLength(1)
  })

  it('switch off: keeps the tombstone and leaves the close to the tab close, as today', () => {
    mocks.layoutOwnerIsMain = false
    pendingLaunch('local', LOCAL)

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, 'local', layoutOwner)

    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(true)
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })
})

describe('a paired server, with main owning the layout', () => {
  it('cancel before the create: keeps the tombstone and hides and closes the late listing', () => {
    pendingLaunch(SERVER_HOST, SERVER)

    markStructuredAgentSessionLaunchCancelled(WORKTREE, SESSION, SERVER_HOST, layoutOwner)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(true)
    expect(mocks.closeSession).not.toHaveBeenCalled()

    expect(suppressCancelledStructuredSessionTabs(hostFrame(), SERVER).tabs).toEqual([])
    expect(mocks.closeSession).toHaveBeenCalledWith(SERVER, SESSION)
  })

  it('create before the cancel: the published chat closes as any chat does, no tombstone', () => {
    pendingLaunch(SERVER_HOST, SERVER)
    expect(suppressCancelledStructuredSessionTabs(hostFrame(), SERVER).tabs).toHaveLength(1)

    // Once the create has answered, the tab is not provisional, so its close cancels nothing.
    beginStructuredAgentSessionTabClose({
      target: SERVER,
      worktreeId: WORKTREE,
      sessionId: SESSION,
      provisional: false,
      layoutOwner
    })

    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE, SESSION)).toBe(false)
    expect(mocks.closeSession).toHaveBeenCalledWith(SERVER, SESSION)
  })
})

it.each([false, true])('rejected paired publication; reply=%s', async (replied) => {
  if (replied) {
    unlisted.recordUnlistedCreatedChat(WORKTREE, SESSION, SERVER_HOST)
  } else {
    pendingLaunch(SERVER_HOST, SERVER)
  }
  acceptSessionTabsRuntimeId('server-1', 'old')
  acceptSessionTabsRuntimeId('server-1', 'new')
  const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
    useAppStore.getState(),
    hostFrame(),
    'server-1',
    { expectedRuntimeId: 'old' }
  )
  expect(decideWebSessionTabsSnapshot(recovered!, 'server-1', 'old').apply).toBe(false)
  expect(getStructuredLaunchStateBySessionId(SESSION)?.hostListed).not.toBe(true)
  expect(unlisted.isUnlistedCreatedChat(WORKTREE, SESSION)).toBe(replied)
  unlisted.forgetUnlistedCreatedChat(WORKTREE, SESSION)
})
