import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { markStructuredAgentSessionLaunchCancelled } from '@/lib/agent-session/launch/structured-agent-session-launch-cancel'
import type { StructuredLaunchSlotOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-slot'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  remember: vi.fn(),
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  callRuntime:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>(),
  discardOutbox: vi.fn<(sessionId: string) => void>(),
  stopSends: vi.fn<(sessionId: string) => void>(),
  hasTombstone: vi.fn<(worktreeId: string, sessionId: string) => boolean>(),
  markCancelled: vi.fn<typeof markStructuredAgentSessionLaunchCancelled>(),
  reacceptLocal:
    vi.fn<(worktreeId: string, options?: { reacceptCurrentVersion?: boolean }) => Promise<void>>(),
  refreshPaired:
    vi.fn<
      (
        environmentId: string,
        worktreeId: string,
        options?: { acceptCurrentSnapshot?: boolean; afterCurrentInFlight?: boolean }
      ) => Promise<void>
    >()
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  hasStructuredAgentSessionLaunchCancellationTombstone: mocks.hasTombstone
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-cancel', () => ({
  markStructuredAgentSessionLaunchCancelled: mocks.markCancelled
}))
vi.mock(
  '@/components/native-chat/session/options/native-chat-session-option-settings-write',
  () => ({
    enqueueSessionOptionSettingsWrite: mocks.remember
  })
)
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: mocks.discardOutbox
}))
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender',
  () => ({
    stopStructuredAgentSessionSends: mocks.stopSends
  })
)
vi.mock('../requests/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntime
}))
vi.mock('../../web-session-tabs-sync/closing/local-session-tab-close-owner', () => ({
  withLocalSessionTabCloseOwner: async (
    _worktreeId: string,
    _tabId: string,
    close: () => Promise<unknown>
  ) => close()
}))
vi.mock('../../local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.reacceptLocal
}))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refreshPaired
}))
vi.mock('../../rpc/targets/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  beginStructuredAgentSessionTabClose,
  retireStructuredAgentSessionTab
} from './structured-agent-session-tab-retirement'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner'
import {
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import {
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  resetWebSessionCloseIntentForTests
} from '../../web-session-tabs-sync/closing/web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-sessions/local-structured-session-owner'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'

import {
  structuredSessionSelectionController,
  forgetStructuredSessionSelection
} from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { retirePurgedTabLaunches } from '@/store/slices/worktrees/teardown/purged-structured-launch-retirement'
import { useAppStore } from '@/store/index'
import { agentSessionTabFixture } from '@/components/native-chat/surfaces/integration/native-chat-workspace-test-fixtures'

const layoutOwner: StructuredLaunchSlotOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: vi.fn()
}

const target: RuntimeClientTarget = { kind: 'local' }

beforeEach(() => {
  vi.clearAllMocks()
  resetStructuredAgentSessionReadOwnersForTests()
  resetWebSessionCloseIntentForTests()
  replaceRuntimeEnvironmentRevisions([])
  mocks.closeSession.mockResolvedValue('closed')
  mocks.callRuntime.mockResolvedValue(undefined)
  mocks.hasTombstone.mockReturnValue(false)
  mocks.reacceptLocal.mockResolvedValue(undefined)
  mocks.refreshPaired.mockResolvedValue(undefined)
})

const closing = (owner: string): boolean =>
  isWebSessionCloseIntentPending(
    { environmentId: owner },
    'wt-1',
    'agent-session:session-1',
    Date.now()
  )

describe('structured agent session tab retirement', () => {
  it('hides a closing chat from host frames until one stops listing it', async () => {
    let answerClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerClose = () => resolve(undefined)
        })
    )
    beginStructuredAgentSessionTabClose({
      layoutOwner,
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    // A frame the host sent before handling the close still lists the chat.
    reconcileWebSessionCloseIntents(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      'wt-1',
      new Set(['agent-session:session-1'])
    )
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    answerClose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // This machine's host emitted its removal before answering, so that frame ends it: no read.
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    reconcileWebSessionCloseIntents(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      'wt-1',
      new Set()
    )
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)
  })

  it('clears a paired close intent under the pairing it began with', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 0, pairingRevision: 3 }])
    let failClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failClose = () => reject(new Error('runtime_unavailable'))
        })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      layoutOwner,
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    const pendingUnder = (pairingRevision: number): boolean =>
      isWebSessionCloseIntentPending(
        { environmentId: 'server-1', pairingRevision },
        'wt-1',
        'agent-session:session-1',
        Date.now()
      )
    expect(pendingUnder(3)).toBe(true)

    // Re-paired while the close is in flight.
    replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 0, pairingRevision: 4 }])
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    failClose()
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        expectedEnvironmentPairingRevision: 3
      })
    )
    expect(pendingUnder(3)).toBe(false)
    warn.mockRestore()
  })

  it('deduplicates concurrent host retirement', async () => {
    let release!: () => void
    mocks.closeSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve('closed')
        })
    )
    retireStructuredAgentSessionTab({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
    retireStructuredAgentSessionTab({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1'
    })
    expect(mocks.closeSession).toHaveBeenCalledTimes(1)
    release()
  })

  it('retires an unmounted created reader only on the owning host', async () => {
    const local = getStructuredAgentSessionReadOwner('session-1', target)
    const remoteTarget = { kind: 'environment', environmentId: 'server-1' } as const
    const remote = getStructuredAgentSessionReadOwner('session-1', remoteTarget)
    const dispose = vi.spyOn(local, 'dispose')
    retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    expect(findStructuredAgentSessionReadOwner('session-1', target)).toBeUndefined()
    expect(findStructuredAgentSessionReadOwner('session-1', remoteTarget)).toBe(remote)
    expect(dispose).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
  })

  it('still closes the host tab if reader disposal fails', async () => {
    const owner = getStructuredAgentSessionReadOwner('session-1', target)
    vi.spyOn(owner, 'dispose').mockImplementation(() => {
      throw new Error('subscription cleanup failed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      retireStructuredAgentSessionTab({ target, worktreeId: 'wt-1', sessionId: 'session-1' })
    ).not.toThrow()
    expect(findStructuredAgentSessionReadOwner('session-1', target)).toBeUndefined()
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

it('releases ordinary close/purge owners while retaining the same-session other-host scope', async () => {
  const remote = { kind: 'environment', environmentId: 'selection-generations' } as const
  const local = { kind: 'local' } as const
  const sessionId = 'selection-lifetime'
  const retained = new Set<string>()
  const set = Map.prototype.set
  const del = Map.prototype.delete
  const added = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    if (value?.sessionId === sessionId && value?.controller) {
      retained.add(key)
    }
    return set.call(this, key, value)
  })
  const deleted = vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
    this: Map<unknown, unknown>,
    key
  ) {
    retained.delete(key)
    return del.call(this, key)
  })
  try {
    const previous = structuredSessionSelectionController(remote, sessionId, 'codex')
    previous.issue('model', 'model-1', null)
    expect(retained.size).toBe(1)
    const survivor = structuredSessionSelectionController(local, sessionId, 'codex')
    survivor.issue('model', 'surviving-model', null)
    expect(retained.size).toBe(2)
    const reply = Promise.withResolvers<{ kind: 'accepted'; options: Record<string, string> }>()
    previous!.flush(() => previous!.request(() => reply.promise))
    const drain = previous!.drain()
    await retireStructuredAgentSessionTab({ target: remote, worktreeId: 'wt-1', sessionId })
    await drain
    expect(retained.size).toBe(1)
    expect(survivor.overlay()).toEqual({ model: 'surviving-model' })
    // The host can still finish the accepted write; no obsolete client owner remembers it.
    reply.resolve({ kind: 'accepted', options: { model: 'model-1' } })
    await reply.promise
    await Promise.resolve()
    expect(mocks.remember).not.toHaveBeenCalled()
    expect(previous!.overlay()).toEqual({})
    const noSend = vi.fn()
    await expect(previous!.issue('model', 'dead', null).result).resolves.toEqual({
      kind: 'superseded'
    })
    previous!.flush(noSend)
    expect(previous!.freeze()).toEqual([])
    await expect(previous!.request(noSend)).rejects.toThrow('retired')
    expect(noSend).not.toHaveBeenCalled()
    const purged = structuredSessionSelectionController(remote, sessionId, 'codex')
    expect(purged).not.toBe(previous)
    expect(purged.captureRead()).toEqual([])
    purged.issue('effort', 'high', 'sonnet')
    retirePurgedTabLaunches(
      useAppStore.getState(),
      'wt-1',
      [],
      [
        agentSessionTabFixture(sessionId, 'wt-1', {
          entityId: sessionId,
          executionHostId: 'runtime:selection-generations'
        })
      ],
      new Set([sessionId])
    )
    expect(purged.overlay()).toEqual({})
    expect(retained.size).toBe(1)
    expect(structuredSessionSelectionController(local, sessionId, 'codex')).toBe(survivor)
    expect(survivor.overlay()).toEqual({ model: 'surviving-model' })
    survivor.settle(survivor.pending()[0]!, {
      kind: 'accepted',
      options: { model: 'surviving-model' }
    })
    expect(mocks.remember).toHaveBeenLastCalledWith(local, {
      type: 'apply-picks',
      agent: 'codex',
      picks: [{ modelId: 'surviving-model', optionId: 'model', value: 'surviving-model' }]
    })
    console.info(
      'selection-registry-lifetime',
      JSON.stringify({
        ownerScopes: 2,
        retainedPerChat: 1,
        retainedAfterScopedClose: 1,
        retainedAfterScopedPurge: 1
      })
    )
  } finally {
    forgetStructuredSessionSelection(sessionId)
    added.mockRestore()
    deleted.mockRestore()
  }
})
