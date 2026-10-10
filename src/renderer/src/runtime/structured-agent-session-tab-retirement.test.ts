import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const mocks = vi.hoisted(() => ({
  closeSession:
    vi.fn<(target: RuntimeClientTarget, sessionId: string) => Promise<'closed' | 'unsupported'>>(),
  callRuntime:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>(),
  discardOutbox: vi.fn<(sessionId: string) => void>(),
  stopSends: vi.fn<(sessionId: string) => void>(),
  hasTombstone: vi.fn<(worktreeId: string, sessionId: string) => boolean>(),
  markCancelled:
    vi.fn<(worktreeId: string, sessionId: string, executionHostId: string) => boolean>(),
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

vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  hasStructuredAgentSessionLaunchCancellationTombstone: mocks.hasTombstone,
  markStructuredAgentSessionLaunchCancelled: mocks.markCancelled
}))
vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  discardStructuredAgentSessionChatSends: mocks.discardOutbox
}))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  stopStructuredAgentSessionSends: mocks.stopSends
}))
vi.mock('./structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeSession
}))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntime
}))
vi.mock('./local-session-tab-close-owner', () => ({
  withLocalSessionTabCloseOwner: async (
    _worktreeId: string,
    _tabId: string,
    close: () => Promise<unknown>
  ) => close()
}))
vi.mock('./local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.reacceptLocal
}))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refreshPaired
}))
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  beginStructuredAgentSessionTabClose,
  retireStructuredAgentSessionTab,
  suppressCancelledStructuredSessionTabs
} from './structured-agent-session-tab-retirement'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '@/components/native-chat/structured-agent-session-read-owner'
import {
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const target: RuntimeClientTarget = { kind: 'local' }

function snapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'agent-session:session-1',
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:session-1',
        title: 'Codex Chat',
        sessionId: 'session-1',
        agent: 'codex',
        isActive: true
      }
    ],
    tabGroups: [
      {
        id: 'group-1',
        tabOrder: ['agent-session:session-1'],
        activeTabId: 'agent-session:session-1'
      }
    ]
  }
}

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
  it('marks cancellation and clears local launch state before host cleanup', async () => {
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: true
    })
    expect(mocks.markCancelled).toHaveBeenCalledWith('wt-1', 'session-1', 'local')
    expect(mocks.discardOutbox).toHaveBeenCalledWith('session-1')
    expect(mocks.stopSends).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1')
  })

  // Withdrawn, as a Stop does: nothing more goes out, and nothing is dropped.
  it("never drops a published chat's sends when its tab closes", async () => {
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(mocks.discardOutbox).not.toHaveBeenCalled()
    expect(mocks.stopSends).toHaveBeenCalledWith('session-1')
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
  })

  it('suppresses and retires a late cancelled publication', async () => {
    mocks.hasTombstone.mockReturnValue(true)
    const result = suppressCancelledStructuredSessionTabs(snapshot(), target)
    expect(result.tabs).toEqual([])
    expect(result.tabGroups).toEqual([])
    expect(result.activeTabId).toBeNull()
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(target, 'session-1'))
    expect(mocks.callRuntime).toHaveBeenCalledWith(
      target,
      'session.tabs.close',
      expect.objectContaining({ tabId: 'agent-session:session-1' })
    )
  })

  it('hides a closing chat from host frames until one stops listing it', async () => {
    let answerClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerClose = () => resolve(undefined)
        })
    )
    beginStructuredAgentSessionTabClose({
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

  it('records no intent for a floating-panel chat, whose frames are never applied', async () => {
    mocks.callRuntime.mockRejectedValue(new Error('window relay failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      sessionId: 'session-1',
      provisional: false
    })
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        FLOATING_TERMINAL_WORKTREE_ID,
        'agent-session:session-1',
        Date.now()
      )
    ).toBe(false)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shows a chat the local host kept by re-reading its worktree', async () => {
    mocks.callRuntime.mockRejectedValue(new Error('window relay failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() =>
      expect(mocks.reacceptLocal).toHaveBeenCalledWith('wt-1', { reacceptCurrentVersion: true })
    )
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)
    expect(mocks.refreshPaired).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shows a chat a paired host kept by re-reading its worktree', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    let failClose!: () => void
    mocks.callRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failClose = () => reject(new Error('runtime_unavailable'))
        })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    expect(closing('server-1')).toBe(true)
    expect(closing(LOCAL_STRUCTURED_SESSION_OWNER)).toBe(false)

    await vi.waitFor(() => expect(mocks.callRuntime).toHaveBeenCalled())
    failClose()
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true
      })
    )
    expect(closing('server-1')).toBe(false)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('re-reads a paired server after a successful close, since its frames travel apart from its answer', async () => {
    const paired = { kind: 'environment', environmentId: 'server-1' } as const
    beginStructuredAgentSessionTabClose({
      target: paired,
      worktreeId: 'wt-1',
      sessionId: 'session-1',
      provisional: false
    })
    await vi.waitFor(() =>
      expect(mocks.refreshPaired).toHaveBeenCalledWith('server-1', 'wt-1', {
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true
      })
    )
    // Only a frame without the chat ends the hide.
    expect(closing('server-1')).toBe(true)
    expect(mocks.reacceptLocal).not.toHaveBeenCalled()
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
