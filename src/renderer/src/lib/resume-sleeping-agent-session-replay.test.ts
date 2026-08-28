import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { consumeQueuedStartupAndClearSleepingRecord } from '@/components/terminal-pane/use-terminal-pane-lifecycle'
import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import { buildWorkspaceSessionPayload } from './workspace-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
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
  it('keeps a sleeping record retryable when the first resume spawn never arrives', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)

    // A second activation can observe the failed/in-flight attempt, but must not
    // clear the record or launch a duplicate before the execution host answers.
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('stores provider-session metadata in the queued startup and runtime claim', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    const state = useAppStore.getState()
    expect(state.pendingStartupByTabId[resumedTab.id]?.resumeProviderSession).toEqual(
      record.providerSession
    )
    expect(state.pendingStartupByTabId[resumedTab.id]?.sleepingAgentResumeIdentity).toEqual({
      paneKey: record.paneKey,
      capturedAt: record.capturedAt
    })
    expect(state.automaticAgentResumeClaimsByTabId[resumedTab.id]).toEqual({
      worktreeId: record.worktreeId,
      launchAgent: record.agent,
      providerSession: record.providerSession,
      sleepingAgentResumeIdentity: {
        paneKey: record.paneKey,
        capturedAt: record.capturedAt
      }
    })
  })

  it('retains a same-pane replacement while a stale resume sweep claim is in flight', () => {
    const original = makeRecord({ capturedAt: 1, updatedAt: 1 })
    const replacement = makeRecord({ capturedAt: 2, updatedAt: 2 })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [original.paneKey]: original }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [replacement.paneKey]: replacement }
    } as never)

    // The marked startup matches the provider session but belongs to the
    // replaced capture; it must dedupe without deleting the replacement.
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[replacement.paneKey]).toBe(
      replacement
    )

    // Once startup is consumed, the runtime claim is the remaining dedupe
    // evidence and must preserve the replacement for a later fresh spawn.
    expect(useAppStore.getState().consumeTabStartupCommand(resumedTab.id)).not.toBeNull()
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[replacement.paneKey]).toBe(
      replacement
    )
  })

  // Why the real store actions: the identity marker only works if it survives the
  // queue/consume round trip; doubles cannot catch a field dropped in that path.
  it('clears the record only once the real store round trip yields a spawned startup', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    const resumedTab = useAppStore.getState().tabsByWorktree['wt-1']![0]!
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)

    const state = useAppStore.getState()
    consumeQueuedStartupAndClearSleepingRecord(
      resumedTab.id,
      state.consumeTabStartupCommand,
      (paneKey) => state.sleepingAgentSessionsByPaneKey[paneKey],
      state.clearSleepingAgentSession
    )

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(useAppStore.getState().pendingStartupByTabId[resumedTab.id]).toBeUndefined()
  })

  it('leaves a folder-workspace record retryable when its resume spawn never arrives', () => {
    const record = makeRecord({
      paneKey: 'folder-tab:leaf-1',
      tabId: 'folder-tab',
      worktreeId: 'folder-workspace-1'
    })
    useAppStore.setState({
      tabsByWorktree: { 'folder-workspace-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('folder-workspace-1')).toBe(1)
    const resumedTab = useAppStore.getState().tabsByWorktree['folder-workspace-1']![0]!
    expect(
      useAppStore.getState().pendingStartupByTabId[resumedTab.id]?.sleepingAgentResumeIdentity
    ).toEqual({ paneKey: record.paneKey, capturedAt: record.capturedAt })

    // No fresh PTY ever binds: the record stays available for a later retry.
    expect(resumeSleepingAgentSessionsForWorktree('folder-workspace-1')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['folder-workspace-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

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
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
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
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
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

  it('clears runtime automatic-resume claims when the tab closes', () => {
    const record = makeRecord()
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
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
