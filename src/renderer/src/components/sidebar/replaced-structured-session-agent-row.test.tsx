// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'

// A conversation that replaced another: `terminal-surfaces.ts` reuses the superseded tab, so the
// local surface id still spells the OLD session while `entityId` is the NEW one. PR 2a derives the
// status pane key from the session id alone, so the key no longer names the surface that hosts it.
const OLD_SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const NEW_SESSION = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const LOCAL_TAB_ID = structuredAgentSessionTabId(OLD_SESSION)
const PANE_KEY = structuredAgentSessionPaneKey(NEW_SESSION)

const NOW = 1_757_030_400_000

const replacedTab: Tab = {
  id: LOCAL_TAB_ID,
  entityId: NEW_SESSION,
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: NOW,
  isPinned: false
}

function entry(state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state,
    agentType: 'codex',
    prompt: 'Keep going',
    updatedAt: NOW,
    stateStartedAt: NOW,
    evidenceObservedAt: NOW,
    stateHistory: [],
    worktreeId: 'wt-1',
    tabId: LOCAL_TAB_ID
  } as unknown as AgentStatusEntry
}

const activationMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateTab: vi.fn(),
  focusGroup: vi.fn(),
  setActiveTabType: vi.fn(),
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  dismissStaleAgentRowByKey: vi.fn()
}))

let agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
let capturedRowActivations: {
  paneKey: string
  onActivate: (tabId: string, paneKey: string) => void
}[] = []

function buildMockStoreState(): Record<string, unknown> {
  return {
    agentActivityDisplayMode: 'full',
    acknowledgedAgentsByPaneKey: {},
    cacheTimerByKey: {},
    dropAgentStatus: vi.fn(),
    dismissRetainedAgent: vi.fn(),
    acknowledgeAgents: vi.fn(),
    agentSendPopoverTargetMode: null,
    agentStatusByPaneKey,
    agentStatusEpoch: 1,
    activeTabId: null,
    activeTabType: 'editor',
    activateTab: activationMocks.activateTab,
    focusGroup: activationMocks.focusGroup,
    setActiveTab: vi.fn(),
    setActiveTabType: activationMocks.setActiveTabType,
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: { 'wt-1': [replacedTab] },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    sendPromptToSidebarAgentTarget: vi.fn(),
    settings: { promptCacheTimerEnabled: true, promptCacheTtlMs: 60_000 }
  }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(buildMockStoreState()),
    { getState: () => buildMockStoreState() }
  )
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activationMocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: activationMocks.activateTabAndFocusPane
}))

vi.mock('../terminal-pane/stale-agent-row', () => ({
  dismissStaleAgentRowByKey: activationMocks.dismissStaleAgentRowByKey
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-1'
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: activationMocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' })
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

vi.mock('@/hooks/use-now', () => ({ useNow: vi.fn(() => NOW) }))

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

async function renderRows(): Promise<void> {
  const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
  renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
}

describe('a replaced conversation keeps a working sidebar row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    capturedRowActivations = []
    agentStatusByPaneKey = {}
  })

  it('activates the surface that hosts the session the pane key names', async () => {
    agentStatusByPaneKey = { [PANE_KEY]: entry('working') }
    await renderRows()

    expect(capturedRowActivations).toHaveLength(1)
    const row = capturedRowActivations[0]
    // The row builder synthesizes the missing tab from the pane key, so the id it hands back is the
    // derived one — never the local surface id.
    row.onActivate(structuredAgentSessionTabId(NEW_SESSION), row.paneKey)

    expect(activationMocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1')
    expect(activationMocks.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(activationMocks.activateTab).toHaveBeenCalledWith(LOCAL_TAB_ID, { worktreeId: 'wt-1' })
    expect(activationMocks.setActiveTabType).toHaveBeenCalledWith('agent-session', 'wt-1')
    expect(activationMocks.dismissStaleAgentRowByKey).not.toHaveBeenCalled()
  })

  it('keeps the settled row attributed to the worktree that owns the surface', async () => {
    // A `done` row has no `entry.worktreeId` fallback in the live index: it is bucketed only if the
    // pane key's tab id resolves to a tab, which for a replaced conversation it no longer does.
    agentStatusByPaneKey = { [PANE_KEY]: entry('done') }
    await renderRows()

    expect(capturedRowActivations.map((row) => row.paneKey)).toEqual([PANE_KEY])
  })
})
