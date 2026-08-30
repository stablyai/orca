import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

describe('agent working directory on status entries and sleeping records (STA-5804)', () => {
  it('stamps the directory the hook reported onto the sleeping record', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    // The pane's worktree binding is unchanged — the directory is additional, not a substitute.
    expect(record?.worktreeId).toBe('wt-1')
  })

  it('leaves the directory unknown when the hook reported none', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        { key: 'session_id', id: 'claude-session-1' },
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record).toBeDefined()
    expect(record?.agentCwd).toBeUndefined()
  })

  it('keeps the directory across later events for the same session that omit it', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )
    store.getState().recordAgentProviderSession(
      PANE_KEY,
      'claude',
      providerSession,
      { updatedAt: 20 },
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1'
      }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })

  it('drops the directory when the pane starts a different provider session', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        { key: 'session_id', id: 'claude-session-1' },
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )
    store.getState().recordAgentProviderSession(
      PANE_KEY,
      'claude',
      { key: 'session_id', id: 'claude-session-2' },
      {
        updatedAt: 20
      },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.providerSession.id).toBe('claude-session-2')
    expect(record?.agentCwd).toBeUndefined()
  })

  it('carries a live status row directory into the record the status write derives', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })
  it('drops the directory when a live pane switches to a different provider session', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession: { key: 'session_id', id: 'claude-session-1' } }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'a different job', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'claude-session-2' } }
      )

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.providerSession?.id).toBe('claude-session-2')
    expect(entry?.agentCwd).toBeUndefined()
  })

  it('keeps the directory across a same-session status update that omits it', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
  })

  it('does not carry a directory across execution hosts even when session ids match', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'host a', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'host-a', agentCwd: '/srv/a' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'host b', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'host-b' },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      connectionId: 'host-b'
    })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBeUndefined()
  })

  it('treats explicit local ownership as a host change from SSH', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'host-a', agentCwd: '/srv/a' }
      )
    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      connectionId: null
    })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBeUndefined()
  })

  it('rewrites a recovery record when only its execution host changes', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }
    const routing = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agentCwd: '/same-looking-path'
    }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'same turn', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { ...routing, connectionId: 'host-a' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'same turn', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 10 },
        { ...routing, connectionId: 'host-b' },
        { providerSession }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.connectionId).toBe('host-b')
  })

  it('rewrites a hydrated checkpoint when only its execution host differs', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store.getState().setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: 'same turn', agentType: 'claude' },
      'Claude',
      { updatedAt: 10, stateStartedAt: 10 },
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'host-b',
        agentCwd: '/same-looking-path'
      },
      { providerSession }
    )
    const current = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]!
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: { ...current, connectionId: 'host-a' }
      }
    })

    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.connectionId).toBe('host-b')
  })

  it('does not hand a new session the finished session\u2019s directory', () => {
    // A completed pane cannot reuse its provider session, so nothing "changes" when a new one
    // starts — the absent id must not read as continuity and license the old directory.
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const first = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession: first }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession: first }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'a different job', agentType: 'claude' },
        'Claude',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'claude-session-2' } }
      )

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.providerSession?.id).toBe('claude-session-2')
    expect(entry?.agentCwd).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBeUndefined()
  })

  it('keeps the directory when the same session opens a new turn after done', () => {
    // The other half of the rule: continuity proved by a matching id still carries forward,
    // so a done \u2192 working turn on the same session does not fall back to unknown.
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'and now the lexer', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
  })

  it('lets a later same-session event that first names the directory reach the record', () => {
    // recoveryRecordMatches decides whether the fresh record replaces the checkpoint. Ignoring
    // the directory made a record that gained one look already-matched, so it never landed.
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBeUndefined()

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })

  it('rewrites a checkpoint that differs from the live entry only by the directory', () => {
    // Ablation-only arm: with recoveryRecordMatches fixed, no status event can leave the record
    // behind on the directory alone, so this seeds the lagging record the way session hydration
    // restores one and drives the periodic capture that would otherwise skip the write.
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )
    const hydrated = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(hydrated).toBeDefined()
    const { agentCwd: _dropped, ...withoutDirectory } = hydrated!
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: withoutDirectory } })

    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })
})
