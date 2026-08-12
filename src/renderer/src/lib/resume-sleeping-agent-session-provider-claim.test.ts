import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  paneKey: string,
  origin: SleepingAgentSessionRecord['origin'] = 'quit'
): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'omp',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin,
    launchConfig: {
      agentCommand: 'omp',
      agentArgs: '',
      agentEnv: { PI_CODING_AGENT_DIR: '/tmp/omp-agent' }
    }
  }
}

function makeTerminalTab(id: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeWorkingStatus(
  paneKey: string,
  tabId: string,
  record: SleepingAgentSessionRecord
): Record<string, unknown> {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    agentType: record.agent,
    providerSession: record.providerSession,
    prompt: record.prompt,
    state: 'working',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: []
  }
}

function makePreservedPaneState(record: SleepingAgentSessionRecord): Record<string, unknown> {
  return {
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

describe('resume sleeping agent provider claims', () => {
  it('keeps a pane-owned quit record when its own persisted status is still working', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord(paneKey)
    useAppStore.setState({
      ...makePreservedPaneState(record),
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      agentStatusByPaneKey: { [paneKey]: makeWorkingStatus(paneKey, 'tab-1', record) }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('clears the quit record when another pane already resumed the provider session', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const otherPaneKey = makePaneKey('tab-2', OTHER_LEAF_ID)
    const record = makeRecord(paneKey)
    useAppStore.setState({
      ...makePreservedPaneState(record),
      tabsByWorktree: {
        'wt-1': [makeTerminalTab('tab-1'), makeTerminalTab('tab-2')]
      },
      agentStatusByPaneKey: {
        [otherPaneKey]: makeWorkingStatus(otherPaneKey, 'tab-2', record)
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not launch a hidden pane whose same provider session is still working', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord(paneKey, 'worktree-sleep')
    useAppStore.setState({
      ...makePreservedPaneState(record),
      activeWorktreeId: 'wt-other',
      activeTabId: null,
      activeTabIdByWorktree: {},
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      agentStatusByPaneKey: { [paneKey]: makeWorkingStatus(paneKey, 'tab-1', record) }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
