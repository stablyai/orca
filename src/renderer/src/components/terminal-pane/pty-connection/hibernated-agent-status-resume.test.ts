import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { planAgentHibernationCandidates } from '@/lib/agent-hibernation-planner'

import { restoreCompletedAgentStatusAfterColdResume } from './hibernated-agent-status-resume'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`
const MOVED_PANE_KEY = `tab-2:${LEAF_ID}`
const WORKTREE_ID = 'folder-workspace'
const RESUMED_AT = 2_000_000
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'codex-session-1' }
const LAUNCH_CONFIG = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }

function seedHibernatedCompletion(store: ReturnType<typeof createTestStore>): void {
  const completedEntry = {
    state: 'done' as const,
    prompt: 'finish the task',
    updatedAt: 1_000,
    stateStartedAt: 900,
    agentType: 'codex',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    tabId: 'tab-1',
    terminalTitle: 'Codex',
    stateHistory: [],
    providerSession: PROVIDER_SESSION,
    lastAssistantMessage: 'done'
  }
  store.setState({
    activeWorktreeId: 'foreground-workspace',
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: 'resumed-pty' })]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'resumed-pty' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['resumed-pty'] },
    settings: { experimentalAgentHibernation: true, agentHibernationIdleMs: 60_000 },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {
      [PANE_KEY]: {
        entry: completedEntry,
        worktreeId: WORKTREE_ID,
        tab: makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID }),
        agentType: 'codex',
        startedAt: 900
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: PROVIDER_SESSION,
        prompt: 'finish the task',
        state: 'done',
        capturedAt: 1_100,
        updatedAt: 1_000,
        launchConfig: LAUNCH_CONFIG,
        origin: 'worktree-sleep'
      }
    }
  } as unknown as Partial<AppState>)
}

describe('hibernated agent status resume', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores exact completed-provider status so a mounted cold resume can sleep again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(RESUMED_AT)
    const store = createTestStore()
    seedHibernatedCompletion(store)
    const sleepingRecordEntry = {
      paneKey: PANE_KEY,
      record: store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]!
    }
    const resumeState = store.getState()
    resumeState.clearSleepingAgentSession(PANE_KEY)

    expect(
      restoreCompletedAgentStatusAfterColdResume({
        leafId: LEAF_ID,
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        state: resumeState,
        startup: {
          agent: 'codex',
          command: "codex resume 'codex-session-1'",
          launchConfig: LAUNCH_CONFIG,
          launchToken: 'resume-token',
          resumeProviderSession: PROVIDER_SESSION,
          useLiveEntry: false,
          hasSleepingRecord: true,
          sleepingRecordEntry
        }
      })
    ).toBe(true)

    const resumed = store.getState()
    expect(resumed.agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      state: 'done',
      agentType: 'codex',
      providerSession: PROVIDER_SESSION,
      stateStartedAt: 900
    })
    expect(resumed.retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(resumed.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'live',
      providerSession: PROVIDER_SESSION,
      launchConfig: LAUNCH_CONFIG
    })

    const candidates = planAgentHibernationCandidates({
      settings: resumed.settings,
      activeWorktreeId: resumed.activeWorktreeId,
      foregroundTerminalTabIds: [],
      tabsByWorktree: resumed.tabsByWorktree,
      terminalLayoutsByTabId: resumed.terminalLayoutsByTabId,
      ptyIdsByTabId: resumed.ptyIdsByTabId,
      mobileLockedPtyIds: [],
      agentStatusByPaneKey: resumed.agentStatusByPaneKey,
      sleepingAgentSessionsByPaneKey: resumed.sleepingAgentSessionsByPaneKey,
      lastTerminalInputAtByPaneKey: {},
      foregroundTerminalLastSeenAtByTabId: {},
      ptyBindingFirstSeenAtByPaneKey: { [PANE_KEY]: RESUMED_AT },
      boundaryResolvedAtByPaneKey: {},
      now: RESUMED_AT + 60_001
    })
    expect(candidates.map((candidate) => candidate.paneKey)).toEqual([PANE_KEY])
  })

  it('fails closed when retained completion belongs to another provider session', () => {
    const store = createTestStore()
    seedHibernatedCompletion(store)
    const state = store.getState()
    const sleeping = state.sleepingAgentSessionsByPaneKey[PANE_KEY]!

    expect(
      restoreCompletedAgentStatusAfterColdResume({
        leafId: LEAF_ID,
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        state,
        startup: {
          agent: 'codex',
          command: 'codex resume wrong-session',
          launchConfig: LAUNCH_CONFIG,
          launchToken: 'resume-token',
          resumeProviderSession: { key: 'session_id', id: 'wrong-session' },
          useLiveEntry: false,
          hasSleepingRecord: true,
          sleepingRecordEntry: {
            paneKey: PANE_KEY,
            record: {
              ...sleeping,
              providerSession: { key: 'session_id', id: 'wrong-session' }
            }
          }
        }
      })
    ).toBe(false)
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('removes retained completion under the prior pane key after alias recovery', () => {
    const store = createTestStore()
    seedHibernatedCompletion(store)
    const state = store.getState()
    const sleepingRecordEntry = {
      paneKey: PANE_KEY,
      record: state.sleepingAgentSessionsByPaneKey[PANE_KEY]!
    }
    state.clearSleepingAgentSession(PANE_KEY)

    expect(
      restoreCompletedAgentStatusAfterColdResume({
        leafId: LEAF_ID,
        paneKey: MOVED_PANE_KEY,
        tabId: 'tab-2',
        state,
        startup: {
          agent: 'codex',
          command: "codex resume 'codex-session-1'",
          launchConfig: LAUNCH_CONFIG,
          launchToken: 'resume-token',
          resumeProviderSession: PROVIDER_SESSION,
          useLiveEntry: false,
          hasSleepingRecord: true,
          sleepingRecordEntry
        }
      })
    ).toBe(true)

    expect(store.getState().agentStatusByPaneKey[MOVED_PANE_KEY]).toMatchObject({
      state: 'done',
      providerSession: PROVIDER_SESSION
    })
    expect(store.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
