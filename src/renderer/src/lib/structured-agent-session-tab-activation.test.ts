import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  focusGroup: vi.fn(),
  setActiveTabType: vi.fn(),
  state: { unifiedTabsByWorktree: {} } as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))

vi.mock('./worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-1'
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId: string
  }) => ({ kind: 'environment', environmentId: activeRuntimeEnvironmentId })
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionForRow,
  activateStructuredAgentSessionTab
} from './structured-agent-session-tab-activation'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

describe('activateStructuredAgentSessionTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const tab = {
      id: 'structured-tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: false,
      agentSessionAgent: 'codex'
    } satisfies Tab
    mocks.state = {
      unifiedTabsByWorktree: { 'wt-1': [tab] },
      focusGroup: mocks.focusGroup,
      activateTab: mocks.activateTab,
      setActiveTabType: mocks.setActiveTabType
    }
  })

  it('selects the unified tab and synchronizes host focus', () => {
    expect(
      activateStructuredAgentSessionTab({ worktreeId: 'wt-1', tabId: 'structured-tab-1' })
    ).toBe(true)

    expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mocks.activateTab).toHaveBeenCalledWith('structured-tab-1', { worktreeId: 'wt-1' })
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('agent-session', 'wt-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'session.tabs.activate',
      { worktree: 'id:wt-1', tabId: 'agent-session:session-1' }
    )
  })

  it('activates a status row whose derived tab id no longer names its surface', () => {
    // A replaced conversation reuses the superseded tab, so the local id still spells the old
    // session while the row's key is derived from the new one.
    expect(
      activateStructuredAgentSessionForRow({
        worktreeId: 'wt-1',
        tabId: structuredAgentSessionTabId('session-1')
      })
    ).toBe(true)
    expect(mocks.activateTab).toHaveBeenCalledWith('structured-tab-1', { worktreeId: 'wt-1' })
  })

  it('leaves a row whose tab id encodes no session to the caller', () => {
    expect(activateStructuredAgentSessionForRow({ worktreeId: 'wt-1', tabId: 'worker-tab' })).toBe(
      false
    )
    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  it('routes a provider-owned vault row through its structured session id', () => {
    expect(activateStructuredAgentSessionById({ worktreeId: 'wt-1', sessionId: 'session-1' })).toBe(
      true
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('structured-tab-1', { worktreeId: 'wt-1' })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'session.tabs.activate',
      { worktree: 'id:wt-1', tabId: 'agent-session:session-1' }
    )
  })
})
