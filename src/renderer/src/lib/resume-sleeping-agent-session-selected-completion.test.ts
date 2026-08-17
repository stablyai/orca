import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeCompletedRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('closed-tab', LEAF_ID),
    tabId: 'closed-tab',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
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

describe('selected completed agent resume', () => {
  it('resumes the exact completed record when its pane is gone', () => {
    const selected = makeCompletedRecord()
    const other = makeCompletedRecord({
      paneKey: makePaneKey('other-closed-tab', LEAF_ID),
      tabId: 'other-closed-tab',
      providerSession: { key: 'session_id', id: 'sess-2' }
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: {
        [selected.paneKey]: selected,
        [other.paneKey]: other
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      executionHostId: 'local',
      resumeCompletedPaneKey: selected.paneKey
    })

    const state = useAppStore.getState()
    expect(launched).toBe(1)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.tabsByWorktree['wt-1']?.[0]?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[selected.paneKey]).toBeUndefined()
  })

  it('leaves a preserved selected pane for in-place cold restore', () => {
    const record = makeCompletedRecord({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      tabId: 'tab-1'
    })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      resumeCompletedPaneKey: record.paneKey
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not force a second session while selected-pane hibernation is still killing its PTY', () => {
    const record = makeCompletedRecord({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      tabId: 'tab-1'
    })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      resumeCompletedPaneKey: record.paneKey,
      forceFreshSelectedCompletion: true
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not duplicate a selected provider session that is already active', () => {
    const record = makeCompletedRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('live-tab')] },
      agentStatusByPaneKey: {
        'live-tab:leaf-1': {
          paneKey: 'live-tab:leaf-1',
          tabId: 'live-tab',
          worktreeId: 'wt-1',
          agentType: 'claude',
          state: 'working',
          providerSession: record.providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      resumeCompletedPaneKey: record.paneKey
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
