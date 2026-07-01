import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('stale-tab', OTHER_LEAF_ID),
    tabId: 'stale-tab',
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

function makeTerminalTab(id: string, worktreeId = 'wt-1'): Record<string, unknown> {
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

function makeLiveAgentStatus(paneKey: string, providerSessionId: string): Record<string, unknown> {
  return {
    state: 'working',
    prompt: 'still running',
    updatedAt: 2,
    stateStartedAt: 2,
    agentType: 'claude',
    paneKey,
    worktreeId: 'wt-1',
    tabId: 'tab-live',
    stateHistory: [],
    providerSession: { key: 'session_id', id: providerSessionId }
  }
}

function makePendingLaunchConfigProviderClaim(): Record<string, unknown> {
  return {
    launchConfig: { agentArgs: '', agentEnv: {} },
    registeredAt: 10,
    identity: {
      agentType: 'claude',
      tabId: 'tab-pending',
      leafId: LEAF_ID,
      providerSession: { key: 'session_id', id: 'sess-1' }
    }
  }
}

describe('resumeSleepingAgentSessionsForWorktree provider claims', () => {
  it('uses captured launch config instead of changed settings when resuming worktree sleep', () => {
    const record = makeRecord({
      agent: 'codex',
      launchConfig: {
        agentCommand: "codex --profile captured '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      }
    })
    useAppStore.setState({
      settings: {
        agentCmdOverrides: { codex: 'codex --profile changed' },
        agentDefaultArgs: { codex: '--model changed' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'changed' } }
      },
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    const startup = state.pendingStartupByTabId[resumedTab!.id]
    expect(startup?.command).toBe(
      "codex --profile captured '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'sess-1'"
    )
    expect(startup?.env).toEqual({ CODEX_PROFILE: 'captured' })
    expect(startup?.command).not.toContain('changed')
    expect(startup?.launchConfig).toEqual(record.launchConfig)
  })

  it('launches once and clears skipped duplicates for the same provider session', () => {
    const first = makeRecord({
      paneKey: 'tab-1:leaf-1',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: { agentArgs: '--older', agentEnv: {} }
    })
    const duplicate = makeRecord({
      paneKey: 'tab-2:leaf-1',
      capturedAt: 2,
      updatedAt: 2,
      launchConfig: { agentArgs: '--newer', agentEnv: {} }
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [duplicate.paneKey]: duplicate
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(1)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(state.pendingStartupByTabId[resumedTab!.id]?.launchConfig).toMatchObject({
      agentArgs: '--newer'
    })
    expect(state.sleepingAgentSessionsByPaneKey[first.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[duplicate.paneKey]).toBeUndefined()
  })

  it('dedupes sleeping records when a matching resume startup is already queued', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-queued')] },
      pendingStartupByTabId: {
        'tab-queued': {
          command: "claude '--resume' 'sess-1'",
          launchAgent: 'claude',
          providerSession: { key: 'session_id', id: 'sess-1' },
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.pendingStartupByTabId['tab-queued']).toBeDefined()
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not treat replay-looking queued startup without provider identity as ownership', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-queued')] },
      pendingStartupByTabId: {
        'tab-queued': {
          command: "claude '--resume' 'sess-1'",
          launchAgent: 'claude',
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-queued')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('dedupes sleeping records while a consumed resume startup is pending hooks', () => {
    const paneKey = makePaneKey('tab-pending', LEAF_ID)
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-pending')] },
      agentLaunchConfigByPaneKey: { [paneKey]: makePendingLaunchConfigProviderClaim() },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('keeps pending resume ownership when a delayed hook reports the wrong session', () => {
    const paneKey = makePaneKey('tab-pending', LEAF_ID)
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-pending')] },
      agentLaunchConfigByPaneKey: { [paneKey]: makePendingLaunchConfigProviderClaim() },
      agentStatusByPaneKey: {
        [paneKey]: {
          ...makeLiveAgentStatus(paneKey, 'sess-other'),
          tabId: 'tab-pending'
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('dedupes sleeping records when a matching live agent status already owns the session', () => {
    const paneKey = makePaneKey('tab-live', LEAF_ID)
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-live')] },
      agentStatusByPaneKey: { [paneKey]: makeLiveAgentStatus(paneKey, 'sess-1') },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let a stale orphan live status clear a resumable record', () => {
    const paneKey = makePaneKey('missing-tab', LEAF_ID)
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      agentStatusByPaneKey: {
        [paneKey]: {
          ...makeLiveAgentStatus(paneKey, 'sess-1'),
          tabId: 'missing-tab',
          updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let a wrong live hook session block a different provider resume', () => {
    const paneKey = makePaneKey('tab-live', LEAF_ID)
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-live')] },
      agentStatusByPaneKey: { [paneKey]: makeLiveAgentStatus(paneKey, 'sess-other') },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-live')
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('uses WSL resume quoting for Windows-path projects forced to WSL', () => {
    const record = makeRecord({
      providerSession: { key: 'session_id', id: "sess-1's" }
    })
    useAppStore.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: 'C:\\repo', displayName: 'repo', addedAt: 1 }],
      projects: [
        {
          id: 'repo-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      settings: {
        localWindowsRuntimeDefault: { kind: 'windows-host' },
        agentCmdOverrides: {}
      },
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: 'C:\\repo',
            displayName: 'repo',
            branch: 'main'
          }
        ]
      },
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.command).toContain(
      "'--resume' 'sess-1'\\''s'"
    )
  })
})
