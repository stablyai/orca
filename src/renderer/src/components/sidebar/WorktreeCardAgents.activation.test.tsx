// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as ActivateTabAndFocusPaneModule from '@/lib/activate-tab-and-focus-pane'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
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
let mockUnifiedTabs: Tab[] = []
let mockLayouts: Record<string, TerminalLayoutSnapshot> = {}
let mockPtyIds: Record<string, string[]> = {}
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
    retainedAgentsByPaneKey: {},
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
    unifiedTabsByWorktree: { 'wt-1': mockUnifiedTabs },
    terminalLayoutsByTabId: mockLayouts,
    ptyIdsByTabId: mockPtyIds,
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
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn()
}))

const ownerActivationMocks = vi.hoisted(() => ({
  activateTerminalTabOnOwner: vi.fn()
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
  activateAndRevealWorktree: activationMocks.activateAndRevealWorktree,
  activateAndRevealWorkspace: activationMocks.activateAndRevealWorkspace
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: activationMocks.activateTabAndFocusPane
}))

vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: ownerActivationMocks.activateTerminalTabOnOwner
}))

vi.mock('../terminal-pane/stale-agent-row', () => ({
  dismissStaleAgentRowByKey: staleAgentRowMocks.dismissStaleAgentRowByKey
}))

vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
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
    mockUnifiedTabs = []
    mockLayouts = {}
    mockPtyIds = {}
    activationMocks.activateAndRevealWorkspace.mockReturnValue(true)
    mockAgentActivityDisplayMode = undefined
    mockTabsByWorktree = {}
    mockStructuredTabIds = new Set()
    mockAgentStatusByPaneKey = {}
    mockActiveTabId = null
    mockActiveTabType = 'editor'
    capturedRowActivations = []
    structuredActivationMocks.activateStructuredAgentSessionTab.mockImplementation(
      ({ tabId }: { tabId: string }) => mockStructuredTabIds.has(tabId)
    )
  })

  async function clickRetained(mode: 'compact' | 'full', workspaceId = 'wt-1'): Promise<void> {
    mockAgentActivityDisplayMode = mode
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
    if (mode === 'full') {
      renderToStaticMarkup(<WorktreeCardAgents worktreeId={workspaceId} />)
      capturedRowActivations[0].onActivate('retained-tab', makePaneKey('retained-tab', LEAF_A))
      return
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <WorktreeCardAgents worktreeId={workspaceId} />
          </TooltipProvider>
        )
      )
      const row = host.querySelector('.compact-agent-row')
      expect(row).toBeInstanceOf(HTMLElement)
      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  }

  function retainedRow(): void {
    mockAgents = [
      {
        ...mockAgent({
          paneKey: makePaneKey('retained-tab', LEAF_A),
          tabId: 'retained-tab',
          agentType: 'codex',
          prompt: 'Retained',
          worktreeId: 'wt-1'
        }),
        rowSource: 'retained',
        state: 'done'
      }
    ]
    mockTabsByWorktree = { 'wt-1': [{ id: 'retained-tab' }] }
    mockLayouts = {
      'retained-tab': {
        root: { type: 'leaf', leafId: LEAF_A },
        activeLeafId: LEAF_A,
        expandedLeafId: null
      }
    }
  }

  it.each([
    ['compact', false],
    ['compact', true],
    ['full', false],
    ['full', true]
  ] as const)(
    'opens a retained remote pane without status in %s mode (split=%s)',
    async (mode, split) => {
      retainedRow()
      mockPtyIds = { 'retained-tab': ['remote:host-B@@pty-1'] }
      if (split) {
        mockLayouts['retained-tab'].root = {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        }
        mockLayouts['retained-tab'].activeLeafId = LEAF_B
        mockLayouts['retained-tab'].ptyIdsByLeafId = {
          [LEAF_A]: 'remote:host-B@@pty-1',
          [LEAF_B]: 'remote:host-B@@pty-2'
        }
        mockPtyIds['retained-tab'].push('remote:host-B@@pty-2')
      }
      await clickRetained(mode)
      expect(activationMocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
        executionHostId: 'runtime:host-B'
      })
      expect(activationMocks.activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(
        'retained-tab',
        LEAF_A,
        expect.objectContaining({ ackPaneKeyOnSuccess: makePaneKey('retained-tab', LEAF_A) })
      )
      expect(ownerActivationMocks.activateTerminalTabOnOwner).toHaveBeenCalledWith(
        'wt-1',
        'retained-tab',
        LEAF_A
      )
    }
  )

  it.each([
    'missing',
    'sleeping',
    'stale',
    'other-split',
    'foreign-owner',
    'reveal-failed'
  ] as const)('keeps a retained %s destination inert', async (shape) => {
    retainedRow()
    mockPtyIds = { 'retained-tab': ['live-pty'] }
    if (shape === 'missing') {
      mockTabsByWorktree = {}
    }
    if (shape === 'sleeping') {
      mockPtyIds = {}
      mockLayouts['retained-tab'].ptyIdsByLeafId = { [LEAF_A]: 'persisted-pty' }
    }
    if (shape === 'stale') {
      mockLayouts['retained-tab'].ptyIdsByLeafId = { [LEAF_A]: 'exited-pty' }
    }
    if (shape === 'other-split') {
      mockLayouts['retained-tab'] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        },
        activeLeafId: LEAF_B,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_A]: 'exited-pty', [LEAF_B]: 'live-pty' }
      }
    }
    if (shape === 'foreign-owner') {
      mockPtyIds = { 'retained-tab': ['remote:unscoped-handle'] }
    }
    if (shape === 'reveal-failed') {
      activationMocks.activateAndRevealWorkspace.mockReturnValue(false)
    }
    await clickRetained('full')
    if (shape !== 'reveal-failed') {
      expect(activationMocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    }
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(ownerActivationMocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
    expect(staleAgentRowMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('opens a retained native tab without a PTY using its explicit owner', async () => {
    retainedRow()
    mockTabsByWorktree = {}
    mockUnifiedTabs = [
      {
        id: 'retained-tab',
        entityId: 'session-1',
        contentType: 'agent-session',
        worktreeId: 'wt-1',
        executionHostId: 'runtime:host-B',
        groupId: 'g1',
        label: 'Codex',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
    mockStructuredTabIds.add('retained-tab')
    await clickRetained('full')
    expect(structuredActivationMocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'retained-tab',
      target: { kind: 'environment', environmentId: 'host-B' }
    })
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(ownerActivationMocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
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

  it('tells the owning server which tab a row opens (#12739, #22196)', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'web-terminal-host-tab'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({ paneKey, tabId, agentType: 'codex', prompt: 'Remote', worktreeId: 'wt-1' })
    ]
    mockTabsByWorktree = { 'wt-1': [{ id: tabId }] }
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(ownerActivationMocks.activateTerminalTabOnOwner).toHaveBeenCalledWith(
      'wt-1',
      tabId,
      LEAF_A
    )
    expect(activationMocks.activateTabAndFocusPane).toHaveBeenCalledWith(
      tabId,
      LEAF_A,
      expect.anything()
    )
  })

  it('asks the owner to focus a live row whose tab has not reached this window yet', async () => {
    mockAgentActivityDisplayMode = 'full'
    const tabId = 'web-terminal-unhydrated'
    const paneKey = makePaneKey(tabId, LEAF_A)
    mockAgents = [
      mockAgent({ paneKey, tabId, agentType: 'codex', prompt: 'Remote', worktreeId: 'wt-1' })
    ]
    mockAgentStatusByPaneKey = { [paneKey]: { worktreeId: 'wt-1' } }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    capturedRowActivations[0].onActivate(tabId, paneKey)

    expect(ownerActivationMocks.activateTerminalTabOnOwner).toHaveBeenCalledWith(
      'wt-1',
      tabId,
      LEAF_A
    )
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
    // Model tab hydration during reveal; activation must read the post-reveal store.
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
    // Delegate to the real activation helper while retaining the mock’s call assertions.
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
    // Reveal may activate a fallback before worker hydration; focus only the worker’s exact tab.
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
    // Compact rows must also use tabs hydrated during reveal.
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
