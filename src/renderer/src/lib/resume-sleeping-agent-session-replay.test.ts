import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'

const initialAppStoreState = useAppStore.getState()

beforeEach(() => {
  // Track the original global before the shared fixture installs the renderer API.
  vi.stubGlobal('window', undefined)
  createStoreSessionMockApi()
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.unstubAllGlobals()
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'old-tab:leaf-1',
    tabId: 'old-tab',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

function makeTerminalTab(id: string): Record<string, unknown> {
  return { id, ptyId: null, worktreeId: 'wt-1', title: 'shell', sortOrder: 0, createdAt: 1 }
}

describe('resumeSleepingAgentSessionsForWorktree replay protection', () => {
  it('does not fork a provider session that is already queued', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    useAppStore.setState((state) => ({
      sleepingAgentSessionsByPaneKey: {
        ...state.sleepingAgentSessionsByPaneKey,
        [record.paneKey]: record
      }
    }))

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not fork after startup is consumed but before hooks report live status', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    expect(useAppStore.getState().consumeTabStartupCommand(resumedTab.id)).not.toBeNull()
    expect(useAppStore.getState().pendingStartupByTabId[resumedTab.id]).toBeUndefined()

    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not fork when the same provider session is already live', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('old-tab'), makeTerminalTab('live-tab')] },
      agentStatusByPaneKey: {
        'live-tab:leaf-1': {
          state: 'working',
          prompt: record.prompt,
          updatedAt: 10,
          stateStartedAt: 10,
          agentType: record.agent,
          paneKey: 'live-tab:leaf-1',
          worktreeId: 'wt-1',
          tabId: 'live-tab',
          providerSession: record.providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(2)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let another worktree claim block the same provider session id', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [],
        'wt-2': [{ ...makeTerminalTab('claimed-tab'), worktreeId: 'wt-2' }]
      },
      automaticAgentResumeClaimsByTabId: {
        'claimed-tab': {
          worktreeId: 'wt-2',
          launchAgent: record.agent,
          providerSession: record.providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().tabsByWorktree['wt-2']).toHaveLength(1)
  })
})
