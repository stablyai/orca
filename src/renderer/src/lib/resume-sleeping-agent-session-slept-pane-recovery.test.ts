import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_LEAF_ID = '44444444-4444-4444-8444-444444444444'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
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

function makeLayout(leafId: string, ptyId = 'pty-1'): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

describe('waking panes slept by a manual workspace sleep', () => {
  it('keeps an interrupted worktree-sleep record owned by a preserved pane', () => {
    const record = makeRecord({ interrupted: true })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  // Why: every slept tab except the active one is unowned, so an active-class record there would
  // spawn a duplicate tab and strand the original as a bare shell.
  it('keeps a slept done record on a non-active tab for in-place cold restore', () => {
    const record = makeRecord({ state: 'done' })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'tab-2',
      activeTabIdByWorktree: { 'wt-1': 'tab-2' },
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1', 'wt-1'), makeTerminalTab('tab-2', 'wt-1')]
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(LEAF_ID),
        'tab-2': makeLayout(OTHER_LEAF_ID, 'pty-2')
      },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
