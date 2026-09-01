import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

// Provider-session ownership is keyed on {baseAgent, providerSessionId} (§579):
// a custom id resolves to its resumable base for ownership, so two custom ids on
// one base+session collapse to a single owner and never resume twice, while a
// different base is a distinct owner that cannot over-claim.
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

function makeLiveCustomIdPane(agentType: string, record: SleepingAgentSessionRecord) {
  return {
    state: 'working',
    prompt: record.prompt,
    updatedAt: 10,
    stateStartedAt: 10,
    agentType,
    paneKey: 'live-tab:leaf-1',
    worktreeId: 'wt-1',
    tabId: 'live-tab',
    providerSession: record.providerSession
  }
}

function setStateWithCustomAgent(args: {
  customId: string
  baseAgent: 'claude' | 'codex'
  record: SleepingAgentSessionRecord
}): void {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings,
      customTuiAgents: [
        {
          id: args.customId,
          baseAgent: args.baseAgent,
          label: 'A',
          args: '',
          env: {},
          syncEnv: false
        }
      ]
    },
    tabsByWorktree: { 'wt-1': [makeTerminalTab('live-tab')] },
    agentStatusByPaneKey: {
      'live-tab:leaf-1': makeLiveCustomIdPane(args.customId, args.record)
    },
    sleepingAgentSessionsByPaneKey: { [args.record.paneKey]: args.record }
  } as never)
}

describe('resumeSleepingAgentSessionsForWorktree base-keyed provider-session ownership', () => {
  it('lets a live custom-id pane own its base session so a second id does not re-resume', () => {
    // The record was captured under a *different* custom id on the same base; the
    // live custom-id pane already owns {baseAgent: claude, sess-1}, so no re-resume.
    const record = makeRecord({
      requestedAgent: 'custom-agent:claude:22222222-2222-4222-8222-222222222222',
      baseAgent: 'claude'
    })
    setStateWithCustomAgent({
      customId: 'custom-agent:claude:11111111-1111-4111-8111-111111111111',
      baseAgent: 'claude',
      record
    })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let a live custom-id pane on a different base claim another base session', () => {
    // Same provider session id but a different resumable base is a different owner,
    // so the claude record still resumes once (base mismatch never over-claims).
    const record = makeRecord({ baseAgent: 'claude' })
    setStateWithCustomAgent({
      customId: 'custom-agent:codex:33333333-3333-4333-8333-333333333333',
      baseAgent: 'codex',
      record
    })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })
})
