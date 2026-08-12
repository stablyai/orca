import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('resumeSleepingAgentSessionsForWorktree execution owner', () => {
  it('does not launch or clear a sleeping record owned by another execution host', () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      executionHostId: 'runtime:runtime-b',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    useAppStore.setState({
      activeWorkspaceExecutionHostId: 'local',
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
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not let a foreign live row suppress a local sleeping-session resume', () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      executionHostId: 'local',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    useAppStore.setState({
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-foreign',
            ptyId: 'pty-foreign',
            worktreeId: 'wt-1',
            title: 'foreign',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      agentStatusByPaneKey: {
        'tab-foreign:leaf-1': {
          state: 'working',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'codex',
          paneKey: 'tab-foreign:leaf-1',
          tabId: 'tab-foreign',
          worktreeId: 'wt-1',
          executionHostId: 'runtime:runtime-b',
          providerSession: record.providerSession
        }
      },
      pendingStartupByTabId: {
        'tab-foreign': {
          command: 'codex resume session-1',
          launchAgent: 'codex',
          resumeProviderSession: record.providerSession,
          executionHostId: 'runtime:runtime-b'
        }
      },
      automaticAgentResumeClaimsByTabId: {
        'tab-foreign': {
          worktreeId: 'wt-1',
          launchAgent: 'codex',
          providerSession: record.providerSession,
          executionHostId: 'runtime:runtime-b'
        }
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })
})
