// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as ActivateTabAndFocusPaneModule from '@/lib/activate-tab-and-focus-pane'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

type MockAgentOptions = {
  paneKey: string
  tabId: string
  agentType: string
  prompt: string
  worktreeId: string
  startedAt?: number
}

function mockAgent({
  paneKey,
  tabId,
  agentType,
  prompt,
  worktreeId,
  startedAt = 1000
}: MockAgentOptions): DashboardAgentRowData {
  return {
    paneKey,
    tab: { id: tabId },
    agentType,
    rowSource: 'live',
    state: 'working',
    startedAt,
    entry: {
      prompt,
      state: 'working',
      paneKey,
      updatedAt: startedAt,
      stateStartedAt: startedAt,
      stateHistory: [],
      worktreeId
    }
  } as unknown as DashboardAgentRowData
}

let mockAgents: DashboardAgentRowData[] = []
let mockAgentActivityDisplayMode: 'compact' | 'full' | undefined
let mockTabsByWorktree: Record<string, { id: string }[]> = {}
let mockTerminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }> = {}
let mockStructuredTabIds = new Set<string>()
let mockAgentStatusByPaneKey: Record<string, { worktreeId?: string }> = {}
let mockActiveTabId: string | null = null
let mockActiveTabType: string = 'editor'
const mockSetActiveTab = vi.fn((tabId: string) => {
  mockActiveTabId = tabId
})
const mockSetActiveTabType = vi.fn((tabType: string) => {
  mockActiveTabType = tabType
})
let capturedRowActivations: {
  paneKey: string
  onActivate: (tabId: string, paneKey: string) => void
}[] = []

function buildMockStoreState(): Record<string, unknown> {
  return {
    agentActivityDisplayMode: mockAgentActivityDisplayMode,
    acknowledgedAgentsByPaneKey: {},
    cacheTimerByKey: {},
    dropAgentStatus: vi.fn(),
    dismissRetainedAgent: vi.fn(),
    acknowledgeAgents: vi.fn(),
    agentSendPopoverTargetMode: null,
    agentStatusByPaneKey: mockAgentStatusByPaneKey,
    agentStatusEpoch: 0,
    activeTabId: mockActiveTabId,
    activeTabType: mockActiveTabType,
    setActiveTab: mockSetActiveTab,
    setActiveTabType: mockSetActiveTabType,
    tabsByWorktree: mockTabsByWorktree,
    terminalLayoutsByTabId: mockTerminalLayoutsByTabId,
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    sendPromptToSidebarAgentTarget: vi.fn(),
    settings: {
      promptCacheTimerEnabled: true,
      promptCacheTtlMs: 60_000
    }
  }
}

const activationMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  activateTabAndFocusPane: vi.fn()
}))

const staleAgentRowMocks = vi.hoisted(() => ({
  dismissStaleAgentRowByKey: vi.fn()
}))

const structuredActivationMocks = vi.hoisted(() => ({
  activateStructuredAgentSessionTab: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(buildMockStoreState()),
    {
      getState: () => buildMockStoreState()
    }
  )
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activationMocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: activationMocks.activateTabAndFocusPane
}))

vi.mock('../terminal-pane/stale-agent-row', () => ({
  dismissStaleAgentRowByKey: staleAgentRowMocks.dismissStaleAgentRowByKey
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: structuredActivationMocks.activateStructuredAgentSessionTab
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/hooks/use-now', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({
  default: ({
    agent,
    onActivate
  }: {
    agent: DashboardAgentRowData
    onActivate: (tabId: string, paneKey: string) => void
  }) => {
    capturedRowActivations.push({ paneKey: agent.paneKey, onActivate })
    return <div data-testid="agent-row" data-pane-key={agent.paneKey} />
  }
}))

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => null)
}))

describe('WorktreeCardAgents activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activationMocks.activateAndRevealWorktree.mockImplementation(() => undefined)
    activationMocks.activateTabAndFocusPane.mockImplementation(() => undefined)
    mockAgents = []
    mockAgentActivityDisplayMode = undefined
    mockTabsByWorktree = {}
    mockTerminalLayoutsByTabId = {}
    mockStructuredTabIds = new Set()
    mockAgentStatusByPaneKey = {}
    mockActiveTabId = null
    mockActiveTabType = 'editor'
    capturedRowActivations = []
    structuredActivationMocks.activateStructuredAgentSessionTab.mockImplementation(
      ({ tabId }: { tabId: string }) => mockStructuredTabIds.has(tabId)
    )
  })

  describe.each(['compact', 'full'] as const)('retained %s rows', (displayMode) => {
    it.each([
      ['local PTY', 'local-pty', 'ready', true],
      ['remote PTY', 'remote:host:pty', 'ready', true],
      ['sleeping pane', '', 'ready', false],
      ['another split has a PTY', 'remote:host:pty', 'other-leaf', false],
      ['tab removed after render', 'remote:host:pty', 'removed-tab', false],
      ['PTY removed after render', 'remote:host:pty', 'removed-pty', false],
      ['tab belongs to another worktree', 'remote:host:pty', 'other-worktree', false],
      ['mismatched pane key', 'remote:host:pty', 'mismatched-key', false]
    ])('%s', async (_name, ptyId, scenario, shouldActivate) => {
      mockAgentActivityDisplayMode = displayMode
      const tabId = 'retained-tab'
      const paneKey = makePaneKey(scenario === 'mismatched-key' ? 'other-tab' : tabId, LEAF_A)
      mockAgents = [
        {
          ...mockAgent({
            paneKey,
            tabId,
            agentType: 'codex',
            prompt: 'Waiting for input',
            worktreeId: 'wt-1'
          }),
          rowSource: 'retained',
          state: 'done'
        }
      ]
      mockTabsByWorktree = { [scenario === 'other-worktree' ? 'wt-2' : 'wt-1']: [{ id: tabId }] }
      mockTerminalLayoutsByTabId = {
        [tabId]: { ptyIdsByLeafId: { [scenario === 'other-leaf' ? LEAF_B : LEAF_A]: ptyId } }
      }
      const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      try {
        await act(async () => {
          root.render(
            <TooltipProvider>
              <WorktreeCardAgents worktreeId="wt-1" />
            </TooltipProvider>
          )
        })
        if (scenario === 'removed-tab') {
          mockTabsByWorktree = {}
        }
        if (scenario === 'removed-pty') {
          mockTerminalLayoutsByTabId = {}
        }
        await act(async () => {
          if (displayMode === 'full') {
            capturedRowActivations[0].onActivate(tabId, paneKey)
          } else {
            const row = host.querySelector('.compact-agent-row')
            expect(row).toBeInstanceOf(HTMLElement)
            row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          }
        })
        if (shouldActivate) {
          expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
          expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(tabId, LEAF_A, {
            ackPaneKeyOnSuccess: paneKey,
            flashFocusedPane: true,
            scrollToBottomIfOutputSinceLastView: true
          })
        } else {
          expect(activationMocks.activateAndRevealWorktree).not.toHaveBeenCalled()
          expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
        }
        expect(structuredActivationMocks.activateStructuredAgentSessionTab).not.toHaveBeenCalled()
        expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
        expect(mockAgentStatusByPaneKey).toEqual({})
      } finally {
        act(() => root.unmount())
        host.remove()
      }
    })
  })

  it('activates a projected structured session row through the unified tab path', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'structured-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'codex',
        prompt: 'Structured session',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    mockStructuredTabIds.add(tabId)
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(structuredActivationMocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId
    })
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('reveals the worktree and focuses an automation worker row hydrated during reveal', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'worker-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'codex',
        prompt: 'Run automation worker',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    // Why: activation must use the post-reveal store snapshot, matching tab
    // hydration that arrives while a background worker is being opened.
    activationMocks.activateAndRevealWorktree.mockImplementation(() => {
      mockTabsByWorktree = { 'wt-1': [{ id: tabId }] }
    })
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(tabId, LEAF_A, {
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('reveals the terminal surface through the helper path when activating a hydrated row', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'visible-worker-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'codex',
        prompt: 'Show full log',
        worktreeId: 'wt-1'
      })
    ]
    mockTabsByWorktree = { 'wt-1': [{ id: tabId }] }
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    const actualActivation = await vi.importActual<typeof ActivateTabAndFocusPaneModule>(
      '@/lib/activate-tab-and-focus-pane'
    )
    // Why: keep the component import mocked for call assertions, but delegate
    // this repro to the real helper so it fails if the terminal-surface fix
    // regresses.
    activationMocks.activateTabAndFocusPane.mockImplementation(
      actualActivation.activateTabAndFocusPane
    )
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(tabId, LEAF_A, {
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    expect(mockActiveTabType).toBe('terminal')
    expect(mockActiveTabId).toBe(tabId)
  })

  it('keeps a live worktree-attributed row visible while its tab is hydrating', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'hydrating-worker-tab'
    const paneKey = makePaneKey(tabId, LEAF_B)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'claude',
        prompt: 'Hydrating worker',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('does not pane-focus a fallback terminal when the worker tab is still missing after reveal', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'worker-tab'
    const fallbackTabId = 'fallback-terminal-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'codex',
        prompt: 'Reveal the real worker',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    // Why: activation may create/select a different terminal before the
    // automation worker hydrates; the row must only pane-focus its exact tab.
    activationMocks.activateAndRevealWorktree.mockImplementation(() => {
      mockTabsByWorktree = { 'wt-1': [{ id: fallbackTabId }] }
      mockSetActiveTab(fallbackTabId)
    })
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(mockActiveTabId).toBe(fallbackTabId)
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('dismisses a malformed pane key instead of guessing a terminal pane', async () => {
    mockAgentActivityDisplayMode = 'full'
    const paneKey = 'legacy-pane-key'
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'worker-tab',
        agentType: 'codex',
        prompt: 'Malformed worker',
        worktreeId: 'wt-1'
      })
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

      renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
      expect(capturedRowActivations).toHaveLength(1)
      capturedRowActivations[0].onActivate('worker-tab', paneKey)

      expect(activationMocks.activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
      expect(staleAgentRowMocks.dismissStaleAgentRowByKey).toHaveBeenCalledWith(paneKey)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('dismisses a pane key whose parsed tab does not match the row tab', async () => {
    mockAgentActivityDisplayMode = 'full'
    const paneKey = makePaneKey('other-worker-tab', LEAF_B)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'worker-tab',
        agentType: 'claude',
        prompt: 'Mismatched worker',
        worktreeId: 'wt-1'
      })
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate('worker-tab', paneKey)

    expect(activationMocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).toHaveBeenCalledWith(paneKey)
    warnSpy.mockRestore()
  })

  it('dismisses a missing tab row that is no longer attributed to this worktree', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'stale-worker-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'gemini',
        prompt: 'Stale worker',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-2' } }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).toHaveBeenCalledWith(paneKey)
  })

  it('reveals the worktree and focuses a compact automation worker row hydrated during reveal', async () => {
    mockAgentActivityDisplayMode = 'compact'
    const tabId = 'compact-worker-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId,
        agentType: 'gemini',
        prompt: 'Compact worker',
        worktreeId: 'wt-1'
      })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    // Why: compact rows share the same activation contract as full rows, so
    // this keeps the test pinned to reveal-time tab hydration.
    activationMocks.activateAndRevealWorktree.mockImplementation(() => {
      mockTabsByWorktree = { 'wt-1': [{ id: tabId }] }
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root: Root = createRoot(host)
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    await act(async () => {
      root.render(
        <TooltipProvider>
          <WorktreeCardAgents worktreeId="wt-1" />
        </TooltipProvider>
      )
    })
    const row = host.querySelector('.compact-agent-row')
    expect(row).toBeInstanceOf(HTMLElement)

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(tabId, LEAF_A, {
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    act(() => root.unmount())
    host.remove()
  })
})
