import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialState = useAppStore.getState()

function record(origin: 'live' | 'quit'): SleepingAgentSessionRecord {
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
    origin
  }
}

function setRemoteSleepRecord(value: SleepingAgentSessionRecord): void {
  useAppStore.setState({
    settings: { ...initialState.settings, activeRuntimeEnvironmentId: 'env-1' },
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    sleepingAgentSessionsByPaneKey: { [value.paneKey]: value }
  } as never)
}

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('remote sleeping-agent compatibility', () => {
  it('queues records for transport-level host authority on a capable host', () => {
    const value = record('live')
    setRemoteSleepRecord(value)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    // Retained until the queued startup is consumed (the spawn-success signal).
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[value.paneKey]).toBe(value)
    const state = useAppStore.getState()
    for (const tabId of Object.keys(state.pendingStartupByTabId)) {
      state.consumeTabStartupCommand(tabId)
    }
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[value.paneKey]).toBeUndefined()
  })

  it('preserves legacy automatic wake when host authority is not known', () => {
    const value = record('quit')
    setRemoteSleepRecord(value)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    // Retained until the queued startup is consumed (the spawn-success signal).
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[value.paneKey]).toBe(value)
    const state = useAppStore.getState()
    for (const tabId of Object.keys(state.pendingStartupByTabId)) {
      state.consumeTabStartupCommand(tabId)
    }
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[value.paneKey]).toBeUndefined()
  })
})
