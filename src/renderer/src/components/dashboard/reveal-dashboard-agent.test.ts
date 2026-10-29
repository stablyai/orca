// @vitest-environment happy-dom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'host-A'
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus: mocks.requestNativeChatComposerFocus
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))

vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({ AgentTerminalPreview: () => null }))

import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import { TooltipProvider } from '@/components/ui/tooltip'
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

  it.each(['claude', 'codex'] as const)(
    'opens an existing %s chat without a preview PTY on its own host',
    (agent) => {
      mocks.tabs = [nativeTab(agent)]
      expect(revealDashboardAgent({ ...args, leafId: null })).toBe(true)
      expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
        executionHostId: 'runtime:host-B'
      })
      expect(mocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
      expect(mocks.activateTab).toHaveBeenCalledWith(args.tabId, { worktreeId: 'wt-1' })
      expect(mocks.setActiveTabType).toHaveBeenCalledWith('agent-session', 'wt-1')
      expect(mocks.requestNativeChatComposerFocus).toHaveBeenCalledWith(args.tabId)
      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'host-B' },
        'session.tabs.activate',
        { worktree: 'id:wt-1', tabId: 'agent-session:session-1' }
      )
      expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
      expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
      expect(mocks.activateAndRevealWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.activateTab.mock.invocationCallOrder[0]
      )
    }
  )

  it('opens a native destination through the rendered board and dialog action', () => {
    mocks.tabs = [nativeTab('codex')]
    const card = {
      ...args,
      leafId: null,
      paneKey: 'agent-tab:leaf',
      ptyId: null,
      agentType: 'codex' as const,
      bucket: 'working' as const,
      dotState: 'working' as const,
      task: 'Open this conversation',
      repoName: 'Repo',
      worktreeName: 'Workspace',
      startedAt: 0,
      finishedAt: null,
      stateChangedAt: 0,
      unseen: false
    }
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(AgentKanbanBoard, {
          snapshot: { generatedAt: 0, cards: [card] },
          onAckAgent: () => {},
          onRevealAgent: revealDashboardAgent
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: /Open this conversation/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open worktree' }))
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('agent-session', 'wt-1')
    expect(mocks.activateTab).toHaveBeenCalledWith(args.tabId, { worktreeId: 'wt-1' })
    expect(mocks.requestNativeChatComposerFocus).toHaveBeenCalledWith(args.tabId)
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
  })

  it('does not fall back to a terminal when the current native owner has no runtime', () => {
    mocks.tabs = [{ ...nativeTab('codex'), executionHostId: 'ssh:host-C' }]
    expect(revealDashboardAgent(args)).toBe(false)
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps the terminal route when a native card was closed before its click', () => {
    mocks.tabs = [nativeTab('codex')]
    mocks.tabs = []
    expect(revealDashboardAgent(args)).toBe(true)
    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith('wt-1', args.tabId, args.leafId)
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(args.tabId, args.leafId, {
      flashFocusedPane: true
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTerminalTabOnOwner.mock.invocationCallOrder[0]
    )
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
