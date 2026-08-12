import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('resumeSleepingAgentSessionsForWorktree navigation suppression', () => {
  it('resumes without navigating the desktop when navigation is suppressed', () => {
    // Mobile-scoped wake: the desktop sits on a different worktree/view. The
    // resume must spawn the recovery tab without changing the active surface.
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      activeTabId: 'other-tab',
      activeTabType: 'browser',
      activeTabIdByWorktree: { 'wt-other': 'other-tab' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', { suppressNavigation: true })

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    // A resume tab is created for the slept worktree...
    expect(resumedTab?.launchAgent).toBe('claude')
    // ...but the desktop's active worktree/tab/view are untouched (INV-2).
    expect(state.activeWorktreeId).toBe('wt-other')
    expect(state.activeTabId).toBe('other-tab')
    expect(state.activeTabType).toBe('browser')
  })

  it('skips and preserves a record whose claim an in-place wake already consumed', () => {
    // Regression (#7906): a mounted hibernated pane that consumed the mobile
    // wake starts its own in-place --resume; the generic resume must neither
    // launch a second tab for that provider session nor clear the record (the
    // in-place spawn clears it on success).
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      activeTabId: 'other-tab',
      activeTabType: 'browser',
      activeTabIdByWorktree: { 'wt-other': 'other-tab' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('reports each launched resume tab through onSessionLaunched', () => {
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      activeTabId: 'other-tab',
      activeTabType: 'browser',
      activeTabIdByWorktree: { 'wt-other': 'other-tab' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launchedTabIds: string[] = []
    resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      onSessionLaunched: (tabId) => launchedTabIds.push(tabId)
    })

    const resumedTab = useAppStore
      .getState()
      .tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    // Why: the dispatcher background-mounts exactly these tabs — an
    // activate:false tab otherwise never mounts and its startup never runs.
    expect(resumedTab).toBeDefined()
    expect(launchedTabIds).toEqual([resumedTab?.id])
  })

  it('still navigates to the resumed tab for default (desktop) callers', () => {
    // Regression guard: the suppress-navigation flag must be opt-in — desktop
    // resume keeps flipping the active view to the recovered terminal.
    const record = makeRecord({ origin: 'quit' })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-1',
      activeTabType: 'browser',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(useAppStore.getState().activeTabType).toBe('terminal')
  })
})
