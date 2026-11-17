import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

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
})
