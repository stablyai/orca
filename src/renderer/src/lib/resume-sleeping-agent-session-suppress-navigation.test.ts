import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

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
    // Mobile wake must spawn recovery without changing the desktop’s current worktree/view.
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
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.activeWorktreeId).toBe('wt-other')
    expect(state.activeTabId).toBe('other-tab')
    expect(state.activeTabType).toBe('browser')
  })

  it('skips and preserves a record whose claim an in-place wake already consumed', () => {
    // Mounted hibernated panes own their in-place wake; generic resume must neither duplicate it nor clear its record before spawn succeeds (#7906).
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

  it('leaves the current view alone when the user has left the resumed worktree', () => {
    // Readiness can settle after navigation elsewhere; preserve recovered-tab selection when the user returns.
    const record = makeRecord({ origin: 'quit' })
    const sleptTab: TerminalTab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      activeTabId: 'other-tab',
      activeTabType: 'browser',
      activeTabIdByWorktree: { 'wt-other': 'other-tab' },
      activeTabTypeByWorktree: { 'wt-other': 'browser' },
      tabsByWorktree: { 'wt-1': [sleptTab] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(resumedTab).toBeDefined()
    expect(state.activeTabId).toBe('other-tab')
    expect(state.activeTabType).toBe('browser')
    expect(state.activeTabTypeByWorktree['wt-other']).toBe('browser')
    expect(state.activeTabIdByWorktree['wt-1']).toBe(resumedTab?.id)
    expect(state.activeTabTypeByWorktree['wt-1']).toBe('terminal')
  })
})
