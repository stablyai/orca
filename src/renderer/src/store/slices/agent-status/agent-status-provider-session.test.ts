import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { AppState } from '../../types'
import { getProviderSessionClaimKey } from '../../../../../shared/sleeping-record-legacy-pane-key'
import { createTestStore, seedStore } from '../store-test-helpers'
import { makeTab } from '../store-session-test-harness'
import { makePaneKey } from '../../../../../shared/stable-pane-id'

const PI_COMPATIBLE_CASES = [
  { agent: 'pi' as const, label: 'Pi' },
  { agent: 'omp' as const, label: 'OMP' },
  { agent: 'prime-agent' as const, label: 'Prime Agent' }
]

function makePiCompatibleProviderSession(agent: 'pi' | 'omp' | 'prime-agent') {
  const session = { key: 'session_id' as const, id: `${agent}-session-1` }
  return agent === 'omp' ? session : { ...session, transcriptPath: `/tmp/${agent}-session-1.jsonl` }
}

describe('recordAgentProviderSession', () => {
  it('does not capture a structured native owner for terminal resume on restart', () => {
    const store = createTestStore()
    const paneKey = 'structured-tab:leaf-1'
    const providerSession = { key: 'session_id' as const, id: 'provider-session-uuid' }

    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'keep going', agentType: 'claude' },
        'Claude Chat',
        undefined,
        { tabId: 'structured-tab', worktreeId: 'wt-1' },
        { providerSession, terminalResumeEligible: false }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    expect(store.getState().agentStatusByPaneKey[paneKey]?.providerSession).toEqual(providerSession)
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('preserves the root session while a child permission hook moves Codex to waiting', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'root-session' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'coordinate reviewers', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'waiting',
      prompt: 'coordinate reviewers',
      agentType: 'codex',
      subagents: [{ id: 'child-1', state: 'waiting', startedAt: 11 }]
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Mobile transcript keys on providerSession.id; metadata-less done must not blank chat (#10630).
  it('keeps the provider session when the turn completes without session metadata', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'done',
      prompt: 'summarize the diff',
      agentType: 'claude'
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Repeated metadata-less done repaints/reconnects must retain resting session too, beyond the first done (#10630).
  it('keeps the provider session across repeated metadata-less done pings', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    for (const prompt of ['summarize the diff', 'summarize the diff again']) {
      store
        .getState()
        .setAgentStatus('tab-1:leaf-1', { state: 'done', prompt, agentType: 'claude' })
    }

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Retention ends at turn boundary; fresh working after done must not inherit finished session.
  it('does not carry a completed session into the next turn', () => {
    const store = createTestStore()

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id' as const, id: 'claude-session-1' } }
      )
    store
      .getState()
      .setAgentStatus('tab-1:leaf-1', { state: 'done', prompt: 'first', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:leaf-1', { state: 'working', prompt: 'second', agentType: 'claude' })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toBeUndefined()
  })

  it('uses the session file as part of transcript-based resume ownership only', () => {
    const base = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      prompt: '',
      state: 'working' as const,
      capturedAt: 10,
      updatedAt: 10,
      origin: 'live' as const
    }
    const makeRecord = (
      agent: 'pi' | 'prime-agent' | 'claude',
      transcriptPath: string
    ): SleepingAgentSessionRecord => ({
      ...base,
      agent,
      providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
    })

    expect(getProviderSessionClaimKey(makeRecord('pi', '/tmp/first.jsonl'))).not.toBe(
      getProviderSessionClaimKey(makeRecord('pi', '/tmp/second.jsonl'))
    )
    expect(getProviderSessionClaimKey(makeRecord('prime-agent', '/tmp/first.jsonl'))).not.toBe(
      getProviderSessionClaimKey(makeRecord('prime-agent', '/tmp/second.jsonl'))
    )
    expect(getProviderSessionClaimKey(makeRecord('claude', '/tmp/first.jsonl'))).toBe(
      getProviderSessionClaimKey(makeRecord('claude', '/tmp/second.jsonl'))
    )
  })

  it('keeps Pi session identity durable without fabricating a visible turn', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchConfig = {
      agentCommand: "pi '--model' 'anthropic/claude-sonnet-4'",
      agentArgs: '--model anthropic/claude-sonnet-4',
      agentEnv: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' }
    }
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: '/tmp/pi-session-1.jsonl'
    }

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', launchConfig, {
      agentType: 'pi',
      launchToken: 'pi-launch-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'stale turn', agentType: 'pi' },
        'Pi',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
        { launchToken: 'pi-launch-1' }
      )

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession,
      launchConfig,
      origin: 'live'
    })

    const liveRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    store.getState().captureAllSleepingAgentSessions('periodic')
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(liveRecord)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1', ['tab-1:leaf-1'])
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      launchConfig,
      origin: 'worktree-sleep'
    })
  })

  it('keeps launch flags on the live record of a pane that woke from sleep', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    const paneKey = 'tab-1:leaf-1'
    const launchConfig = {
      agentArgs: '--dangerously-skip-permissions --model haiku',
      agentEnv: { CLAUDE_PROFILE: 'work' }
    }
    store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
      agentType: 'claude',
      launchToken: 'wake-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    // The woken pane's spawn consumes the sleeping record it resumed.
    store.getState().clearSleepingAgentSession(paneKey)
    store
      .getState()
      .recordAgentProviderSession(
        paneKey,
        'claude',
        { key: 'session_id', id: 'claude-session-1' },
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
        { launchToken: 'wake-1' }
      )

    // This record is what the next cold restore resumes from.
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.launchConfig).toEqual(
      launchConfig
    )
  })

  it('keeps the activity cutoff and manual-unread stamp across a heartbeat for the same pane', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: '/tmp/pi-session-1.jsonl'
    }
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'finish', agentType: 'pi' },
        'Pi',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )
    store.getState().applyActivityClearedAt({ 'tab-1:leaf-1': 5_000 })
    store.getState().unacknowledgeAgents(['tab-1:leaf-1'])

    store.getState().recordAgentProviderSession(
      'tab-1:leaf-1',
      'pi',
      providerSession,
      { updatedAt: 20 },
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null
      }
    )

    // Live-to-sleeping preserves pane identity; clearing read maps replays dismissed history on heartbeat.
    expect(store.getState().activityClearedAtByPaneKey['tab-1:leaf-1']).toBe(5_000)
    expect(store.getState().manuallyUnreadTurnsByPaneKey['tab-1:leaf-1']).toBeGreaterThan(0)
  })

  it('does not reuse Pi launch config when the session file identity changes', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'pi',
          providerSession: {
            key: 'session_id',
            id: 'pi-session-1',
            transcriptPath: '/tmp/pi-session-old.jsonl'
          },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          launchConfig: { agentArgs: '--model old', agentEnv: { PI_PROFILE: 'old' } },
          origin: 'live'
        }
      }
    } as Partial<AppState>)

    store.getState().recordAgentProviderSession(
      'tab-1:leaf-1',
      'pi',
      {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-new.jsonl'
      },
      { updatedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig
    ).toBeUndefined()
  })

  it.each(PI_COMPATIBLE_CASES)(
    'keeps a completed $label session resumable through manual worktree sleep',
    async ({ agent, label }) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
        }
      } as Partial<AppState>)
      const providerSession = makePiCompatibleProviderSession(agent)

      store
        .getState()
        .recordAgentProviderSession(
          'tab-1:leaf-1',
          agent,
          providerSession,
          { updatedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 20, stateStartedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'done', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 30, stateStartedAt: 30 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )

      expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.state).toBe('done')
      const liveRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
      expect(liveRecord).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'done',
        origin: 'live'
      })

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(liveRecord)

      await store.getState().shutdownWorktreeTerminals('wt-1', {
        keepIdentifiers: true,
        shutdownReason: 'manual-sleep',
        sleepingPaneKeys: ['tab-1:leaf-1']
      })

      expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeUndefined()
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'working',
        origin: 'worktree-sleep'
      })
    }
  )

  it('does not turn a completed recovery record back into working on a same-session update', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = makePiCompatibleProviderSession('pi')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'finish the task', agentType: 'pi', interrupted: true },
        'Pi',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 40 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      state: 'done',
      interrupted: true,
      origin: 'live'
    })
  })

  it('keeps a completed recovery record failed on a same-session update', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = makePiCompatibleProviderSession('pi')

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'done',
        prompt: 'finish the task',
        agentType: 'pi',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 30 }
      },
      'Pi',
      { updatedAt: 30, stateStartedAt: 30 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession }
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 30 }
    })

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 40 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 30 },
      origin: 'live'
    })
  })

  it('does not downgrade a quit recovery record on a same-session update', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = makePiCompatibleProviderSession('pi')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 40 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      state: 'done',
      origin: 'quit'
    })
  })

  it.each(PI_COMPATIBLE_CASES)(
    'keeps a completed $label session resumable through quit capture',
    ({ agent, label }) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
        }
      } as Partial<AppState>)
      const providerSession = makePiCompatibleProviderSession(agent)

      store
        .getState()
        .recordAgentProviderSession(
          'tab-1:leaf-1',
          agent,
          providerSession,
          { updatedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 20, stateStartedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'done', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 30, stateStartedAt: 30 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        providerSession,
        connectionId: 'ssh-connection-1',
        origin: 'live'
      })

      store.getState().captureAllSleepingAgentSessions('quit')

      const quitRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
      expect(quitRecord).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'done',
        origin: 'quit'
      })

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(quitRecord)
    }
  )
})

describe('Cursor quit checkpoint', () => {
  it.each(['working', 'done'] as const)(
    'retains the same %s conversation in a folder workspace',
    (state) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: { 'folder-1': [makeTab({ id: 'tab-1', worktreeId: 'folder-1' })] }
      })
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'remember the codeword', agentType: 'cursor' },
          'Cursor',
          { updatedAt: 10, stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'folder-1' },
          { providerSession: { key: 'conversation_id', id: 'conversation-742' } }
        )
      if (state === 'done') {
        store.getState().setAgentStatus('tab-1:leaf-1', {
          state,
          prompt: 'remember the codeword',
          agentType: 'cursor'
        })
      }
      store.getState().captureAllSleepingAgentSessions('quit')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        agent: 'cursor',
        state,
        worktreeId: 'folder-1',
        providerSession: { key: 'conversation_id', id: 'conversation-742' },
        origin: state === 'done' ? 'live' : 'quit'
      })
    }
  )
})

describe('quit-time capture for newly resumable agents', () => {
  it('checkpoints a live Kimi provider session before quit-time capture', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    })

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'finish the task',
        agentType: 'kimi'
      },
      'Kimi',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      {
        providerSession: {
          key: 'session_id',
          id: 'session_431324d7-2165-42f0-9ecd-9f93437b3201'
        }
      }
    )

    // Kimi must be resumable or no sleeping record survives restart (#15155).
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'kimi',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      providerSession: { key: 'session_id', id: 'session_431324d7-2165-42f0-9ecd-9f93437b3201' },
      origin: 'live'
    })
  })
})

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'deferred-session' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    restoreOnTabOpenOnly: true,
    ...overrides
  }
}

describe('rememberSleepingAgentSession', () => {
  it('keeps the resume handle of a pane whose restore was deferred', () => {
    const store = createTestStore()
    store.getState().rememberSleepingAgentSession(record())
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toEqual(record())
  })

  it('never replaces a record the pane already has', () => {
    const store = createTestStore()
    const existing = record({ prompt: 'the original task', origin: 'quit' })
    store.getState().rememberSleepingAgentSession(existing)
    store.getState().rememberSleepingAgentSession(record())
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(existing)
  })
})

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

describe('sleepingAgentSessionsByPaneKey after reminted-hook settlement', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles a live working record to done instead of latching at working', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      sleepingAgentSessionsByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'omp',
          providerSession: { key: 'session_id', id: 'omp-session-1' },
          prompt: 'finish the reminted pane',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          terminalTitle: 'OMP ready'
        }
      }
    })

    store.getState().setAgentStatus(
      PANE,
      {
        state: 'working',
        prompt: 'finish the reminted pane',
        agentType: 'omp'
      },
      'OMP ready',
      { updatedAt: 2 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )
    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'finish the reminted pane',
        agentType: 'omp'
      },
      'OMP ready',
      { updatedAt: 3 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(store.getState().agentStatusByPaneKey[PANE]?.state).toBe('done')
    const sleeping = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(sleeping?.state === 'working' && sleeping.prompt === 'finish the reminted pane').toBe(
      false
    )
  })
})
