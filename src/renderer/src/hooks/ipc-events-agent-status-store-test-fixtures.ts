import { expect, vi } from 'vitest'
import type {
  AgentStatusBatchTransaction,
  AgentStatusBatchUpdate
} from '../store/slices/agent-status'
import type { AppState } from '../store/types'
import { makePaneKey } from '../../../shared/stable-pane-id'

export const FUTURE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const STALE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const ORPHAN_LEAF_ID = '33333333-3333-4333-8333-333333333333'
export const TAB_1_LEAF_ID = '44444444-4444-4444-8444-444444444444'
export const FUTURE_PANE_KEY = makePaneKey('tab-future', FUTURE_LEAF_ID)
export const STALE_PANE_KEY = makePaneKey('tab-future', STALE_LEAF_ID)
export const ORPHAN_PANE_KEY = makePaneKey('tab-orphan', ORPHAN_LEAF_ID)
export const TAB_1_PANE_KEY = makePaneKey('tab-1', TAB_1_LEAF_ID)

export function expectWorktreeRouting(worktreeId: string): unknown {
  return expect.objectContaining({ worktreeId })
}

export type AgentStatusSetData = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  state: 'working' | 'blocked' | 'waiting' | 'done'
  prompt?: string
  agentType?: string
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  sessionBoundary?: boolean
  turnCompletedAt?: number
  terminalHandle?: string
  launchToken?: string
  providerSession?: { key: 'session_id'; id: string }
  providerSessionOnly?: boolean
  orchestration?: {
    taskId?: string
    dispatchId?: string
    parentTerminalHandle?: string
    parentPaneKey?: string
    coordinatorHandle?: string
    orchestrationRunId?: string
  }
  connectionId?: string | null
  receivedAt: number
  stateStartedAt: number
}
export type StoreLike = Record<string, unknown>
export type StoreSubscribeListener = (state: StoreLike, previousState: StoreLike) => void
export type MobileFitEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
}
export type MobileFitListener = (event: MobileFitEvent) => void
export type MobileDriverListener = (event: {
  ptyId: string
  driver: { kind: 'mobile'; clientId: string }
}) => void
export type MobileBrowserDriverListener = (event: {
  browserPageId: string
  driver: { kind: 'mobile'; clientId: string }
}) => void

export function applyMockAgentStatusUpdate(
  state: StoreLike,
  update: AgentStatusBatchUpdate
): boolean {
  const statuses = state.agentStatusByPaneKey as Record<
    string,
    | ({ agentType?: string; state?: string; updatedAt?: number } & Record<string, unknown>)
    | undefined
  >
  const existing = statuses[update.paneKey]
  const updatedAt = update.timing?.updatedAt
  if (
    existing?.updatedAt !== undefined &&
    updatedAt !== undefined &&
    updatedAt < existing.updatedAt
  ) {
    return false
  }
  const next = { ...statuses }
  if (update.kind === 'providerSession') {
    delete next[update.paneKey]
  } else {
    next[update.paneKey] = {
      ...existing,
      ...update.payload,
      updatedAt,
      providerSession: update.metadata?.providerSession
    }
  }
  state.agentStatusByPaneKey = next
  return true
}

export function installMockAgentStatusTransaction(state: StoreLike): void {
  state.transactAgentStatuses = <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ): Result => {
    const stagedState = {
      ...state,
      agentStatusByPaneKey: {
        ...(state.agentStatusByPaneKey as Record<string, unknown>)
      }
    }
    const attemptedUpdates: AgentStatusBatchUpdate[] = []
    const effects: (() => void)[] = []
    const result = operation({
      getState: () => stagedState as AppState,
      apply: (update) => {
        attemptedUpdates.push(update)
        return applyMockAgentStatusUpdate(stagedState, update)
      },
      afterCommit: (effect) => effects.push(effect)
    })
    const setStatuses = state.setAgentStatuses as (
      updates: readonly AgentStatusBatchUpdate[]
    ) => readonly boolean[]
    setStatuses(attemptedUpdates)
    for (const effect of effects) {
      effect()
    }
    return result
  }
}

export function buildStoreState(overrides: StoreLike): StoreLike {
  // Why: copy the defensive set of getState() fields the hook touches during
  // mount so individual tests only need to override workspaceSessionReady,
  // tabsByWorktree, and setAgentStatus.
  const state: StoreLike = {
    setUpdateStatus: vi.fn(),
    fetchRepos: vi.fn(),
    fetchWorktrees: vi.fn(),
    setActiveView: vi.fn(),
    activeModal: null,
    closeModal: vi.fn(),
    openModal: vi.fn(),
    activeWorktreeId: 'wt-1',
    activeView: 'terminal',
    setActiveRepo: vi.fn(),
    setActiveWorktree: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    setIsFullScreen: vi.fn(),
    updateBrowserTabPageState: vi.fn(),
    activeTabType: 'terminal',
    editorFontZoomLevel: 0,
    setEditorFontZoomLevel: vi.fn(),
    setRateLimitsFromPush: vi.fn(),
    updateWorktreeBaseStatus: vi.fn(),
    updateWorktreeRemoteBranchConflict: vi.fn(),
    setSshConnectionState: vi.fn(),
    setSshTargetLabels: vi.fn(),
    setPortForwards: vi.fn(),
    clearPortForwards: vi.fn(),
    setDetectedPorts: vi.fn(),
    enqueueSshCredentialRequest: vi.fn(),
    removeSshCredentialRequest: vi.fn(),
    clearTabPtyId: vi.fn(),
    updateTabTitle: vi.fn(),
    updateTabTitles: vi.fn(),
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    setAgentStatuses: vi.fn(() => []),
    recordAgentProviderSession: vi.fn(),
    clearTransientAgentStatuses: vi.fn(),
    getAgentLaunchConfigForStatusMetadata: vi.fn(() => undefined),
    recentlyClosedAgentStatusTabIds: {},
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    workspaceSessionReady: false,
    settings: { terminalFontSize: 13 },
    ...overrides
  }
  if (!('updateTabTitles' in overrides)) {
    state.updateTabTitles = vi.fn((updates: readonly { tabId: string; title: string }[]) => {
      const updateTitle = state.updateTabTitle as AppState['updateTabTitle']
      for (const { tabId, title } of updates) {
        updateTitle(tabId, title)
      }
    })
  }
  if (!('setAgentStatuses' in overrides)) {
    state.setAgentStatuses = vi.fn((updates: readonly AgentStatusBatchUpdate[]) =>
      updates.map((update) => {
        if (update.kind === 'providerSession') {
          const recordProviderSession =
            state.recordAgentProviderSession as AppState['recordAgentProviderSession']
          recordProviderSession(
            update.paneKey,
            update.agent,
            update.providerSession,
            update.timing,
            update.routing,
            update.metadata
          )
        } else {
          const setStatus = state.setAgentStatus as AppState['setAgentStatus']
          setStatus(
            update.paneKey,
            update.payload,
            update.terminalTitle,
            update.timing,
            update.routing,
            update.metadata
          )
        }
        return true
      })
    )
  }
  installMockAgentStatusTransaction(state)
  return state
}
