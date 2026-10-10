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
  activateStructuredAgentSessionTab,
  findStructuredAgentSessionTab
} from './structured-agent-session-tab-activation'

describe('findStructuredAgentSessionTab', () => {
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
    createdAt: 0
  } satisfies Tab

  it('matches the native session identity in its workspace inventory', () => {
    expect(
      findStructuredAgentSessionTab(
        { 'wt-1': [tab] },
        { workspaceId: 'wt-1', sessionId: 'session-1' }
      )
    ).toBe(tab)
  })

  it('does not match a session or tab from another workspace', () => {
    expect(
      findStructuredAgentSessionTab(
        { 'wt-1': [tab] },
        { workspaceId: 'wt-1', sessionId: 'session-2' }
      )
    ).toBeNull()
    expect(
      findStructuredAgentSessionTab(
        { 'wt-2': [{ ...tab, worktreeId: 'wt-2' }] },
        { workspaceId: 'wt-1', sessionId: 'session-1' }
      )
    ).toBeNull()
    expect(
      findStructuredAgentSessionTab(
        { 'wt-1': [{ ...tab, worktreeId: 'wt-2' }] },
        { workspaceId: 'wt-1', sessionId: 'session-1' }
      )
    ).toBeNull()
  })
})

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

  // The resume dialog names the machine: a same-named workspace on another machine never answers,
  // and the focus goes to that machine under the pairing the chat was listed with.
  it('activates only the named machine’s tab, under the listed pairing', () => {
    const elsewhere = {
      id: 'structured-tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    } satisfies Tab
    mocks.state = {
      ...mocks.state,
      unifiedTabsByWorktree: {
        'wt-1': [{ ...elsewhere, id: 'local-tab', executionHostId: 'local' }]
      }
    }
    expect(
      activateStructuredAgentSessionById({
        worktreeId: 'wt-1',
        sessionId: 'session-1',
        target: { kind: 'environment', environmentId: 'studio' }
      })
    ).toBe(false)
    mocks.state = {
      ...mocks.state,
      unifiedTabsByWorktree: {
        'wt-1': [
          { ...elsewhere, id: 'local-tab', executionHostId: 'local' },
          { ...elsewhere, id: 'studio-tab', executionHostId: 'runtime:studio' }
        ]
      }
    }
    expect(
      activateStructuredAgentSessionById({
        worktreeId: 'wt-1',
        sessionId: 'session-1',
        target: { kind: 'environment', environmentId: 'studio' },
        pairingRevision: 4
      })
    ).toBe(true)
    expect(mocks.activateTab).toHaveBeenCalledWith('studio-tab', { worktreeId: 'wt-1' })
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'studio' },
      'session.tabs.activate',
      { worktree: 'id:wt-1', tabId: 'agent-session:session-1' },
      { expectedEnvironmentPairingRevision: 4 }
    )
  })
})
