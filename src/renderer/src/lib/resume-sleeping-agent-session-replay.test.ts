import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import { buildWorkspaceSessionPayload } from './workspace-session'

vi.mock('../hooks/remote-workspace-snapshot-apply', () => ({
  isDirectSshRemoteWorkspaceApplyInProgress: vi.fn(() => false)
}))

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function stubEmptyPartitions(): void {
  vi.stubGlobal('window', {
    api: { session: { get: vi.fn().mockResolvedValue({ tabsByWorktree: {} } as never) } }
  })
}

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
  it('stores provider-session metadata in the queued startup and runtime claim', async () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    stubEmptyPartitions()

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    })
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    const state = useAppStore.getState()
    expect(state.pendingStartupByTabId[resumedTab.id]?.resumeProviderSession).toEqual(
      record.providerSession
    )
    expect(state.automaticAgentResumeClaimsByTabId[resumedTab.id]).toEqual({
      worktreeId: record.worktreeId,
      launchAgent: record.agent,
      providerSession: record.providerSession
    })
  })

  it('does not fork a provider session that is already queued', async () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    stubEmptyPartitions()

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    })

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

  it('does not fork after startup is consumed but before hooks report live status', async () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    stubEmptyPartitions()

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    })
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

  it('does not let another worktree claim block the same provider session id', async () => {
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
    stubEmptyPartitions()

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    })
    expect(useAppStore.getState().tabsByWorktree['wt-2']).toHaveLength(1)
  })

  it('clears runtime automatic-resume claims when the tab closes', async () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    stubEmptyPartitions()

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    })
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    expect(useAppStore.getState().automaticAgentResumeClaimsByTabId[resumedTab.id]).toBeDefined()

    useAppStore.getState().closeTab(resumedTab.id)

    expect(useAppStore.getState().automaticAgentResumeClaimsByTabId[resumedTab.id]).toBeUndefined()
  })

  it('does not include runtime automatic-resume claims in workspace-session payloads', () => {
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1')] },
      automaticAgentResumeClaimsByTabId: {
        'tab-1': {
          worktreeId: 'wt-1',
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' }
        }
      }
    } as never)

    const payload = buildWorkspaceSessionPayload(useAppStore.getState())

    expect('automaticAgentResumeClaimsByTabId' in payload).toBe(false)
  })

  it('leaves explicit AI Vault resumes outside automatic-resume claims', () => {
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [] } } as never)

    const first = launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      command: "codex resume 'sess-1'",
      launchConfig: { agentArgs: '', agentEnv: {} }
    })
    const second = launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      command: "codex resume 'sess-1'",
      launchConfig: { agentArgs: '', agentEnv: {} }
    })

    expect(first.tabId).not.toBe(second.tabId)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(2)
    expect(useAppStore.getState().automaticAgentResumeClaimsByTabId).toEqual({})
  })
})
