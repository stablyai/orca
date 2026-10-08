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
    vi.fn<(worktreeId: string, sessionId: string, executionHostId: string) => boolean>()
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
vi.mock('./runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  beginStructuredAgentSessionTabClose,
  retireStructuredAgentSessionTab,
  suppressCancelledStructuredSessionTabs
} from './structured-agent-session-tab-retirement'

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
  mocks.closeSession.mockResolvedValue('closed')
  mocks.callRuntime.mockResolvedValue(undefined)
  mocks.hasTombstone.mockReturnValue(false)
})

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
})
