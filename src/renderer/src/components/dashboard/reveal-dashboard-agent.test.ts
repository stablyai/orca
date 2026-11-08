// @vitest-environment happy-dom

import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateTerminalTabOnOwner: vi.fn(),
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  requestNativeChatComposerFocus: vi.fn(),
  focusGroup: vi.fn(),
  activateTab: vi.fn(),
  setActiveTabType: vi.fn(),
  tabs: new Array<Tab>()
}))
const getState = () => ({
  unifiedTabsByWorktree: { 'wt-1': mocks.tabs },
  focusGroup: mocks.focusGroup,
  activateTab: mocks.activateTab,
  setActiveTabType: mocks.setActiveTabType
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => getState() } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => getState() } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'host-A'
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: mocks.requestNativeChatComposerFocus
}))
vi.mock('@/runtime/rpc/targets/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))

vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({ AgentTerminalPreview: () => null }))

import { revealDashboardAgent } from './reveal-dashboard-agent'

const args = {
  repoId: 'repo-1',
  worktreeId: 'wt-1',
  executionHostId: 'runtime:host-A' as const,
  tabId: 'agent-tab',
  leafId: '11111111-1111-4111-8111-111111111111'
}
function nativeTab(agent: 'claude' | 'codex'): Tab {
  return {
    id: args.tabId,
    worktreeId: args.worktreeId,
    executionHostId: 'runtime:host-B',
    contentType: 'agent-session',
    entityId: 'session-1',
    groupId: 'group-1',
    label: agent,
    agentSessionAgent: agent,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

afterEach(cleanup)

describe('revealDashboardAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tabs = []
    mocks.activateAndRevealWorkspace.mockReturnValue(true)
  })

  it('does not fall back to a terminal when the current native owner has no runtime', () => {
    mocks.tabs = [{ ...nativeTab('codex'), executionHostId: 'ssh:host-C' }]
    expect(revealDashboardAgent(args)).toBe(false)
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it.each([false, true])('touches no tab when workspace reveal fails (native=%s)', (native) => {
    mocks.tabs = native ? [nativeTab('codex')] : []
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    expect(revealDashboardAgent(args)).toBe(false)
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(mocks.activateTab).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
