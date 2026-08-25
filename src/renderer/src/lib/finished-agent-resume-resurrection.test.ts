/**
 * A LOCAL workspace agent that FINISHED its turn must keep its resume identity
 * without being treated as unfinished work.
 *
 * `retainsResumableRecoveryIdentity` (store/slices/agent-status.ts) records a
 * completed turn so a cold restore after an abrupt app death re-enters the agent
 * instead of a bare shell (#9454). It used to do that by restating `done` as
 * `state: 'working'`, which left nothing able to tell "finished" from
 * "interrupted": once the pane was killed, activation opened a fresh tab running
 * `--resume` for every completed agent.
 *
 * No paired runtime here: the host-mirror park added in #15644 gates on a web
 * surface tab id, so this path never reaches it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isPassiveCompletedHibernationEvidence } from './sleeping-agent-pane-ownership'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'wt-local'
const TAB_ID = 'tab-reviewer'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const SESSION_ID = 'ses_fdc9b294effeBRR2JwiALSLpwy'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

/** A local codex pane with a live PTY, mid-turn. */
function seedLiveLocalCodexPane(): void {
  useAppStore.setState({
    activeWorktreeId: WORKTREE_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'codex'
        }
      ]
    },
    activeTabIdByWorktree: { [WORKTREE_ID]: TAB_ID },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    }
  } as never)
}

function reportTurnFinished(interrupted = false): void {
  useAppStore.getState().setAgentStatus(
    PANE_KEY,
    {
      state: 'done',
      agentType: 'codex',
      prompt: 'review the diff',
      ...(interrupted ? { interrupted: true } : {})
    } as never,
    'Codex',
    { updatedAt: 1000, stateStartedAt: 1000 },
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, terminalHandle: 'pty-1' } as never,
    { providerSession: { key: 'session_id', id: SESSION_ID } } as never
  )
}

describe('a finished local agent', () => {
  it('keeps completed quit records resumable', () => {
    expect(
      isPassiveCompletedHibernationEvidence({
        paneKey: 'quit-tab:quit-leaf',
        tabId: 'quit-tab',
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: SESSION_ID },
        prompt: '',
        state: 'done',
        origin: 'quit',
        capturedAt: 1,
        updatedAt: 1
      })
    ).toBe(false)
  })

  it('keeps its resume identity and is recorded as completed history', () => {
    seedLiveLocalCodexPane()

    reportTurnFinished()

    const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record, 'a finished codex turn leaves a resume record').toBeDefined()
    expect(record?.state, 'the done turn stays done').toBe('done')
    expect(record?.origin).toBe('live')
    // The identity a cold restore needs survives; only the turn text is dropped.
    expect(record?.agent).toBe('codex')
    expect(record?.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
    expect(
      isPassiveCompletedHibernationEvidence(record!),
      'a finished agent must read as history, or activation restarts it'
    ).toBe(true)
  })

  it('keeps an interrupted done turn resumable after its pane is killed', () => {
    seedLiveLocalCodexPane()
    reportTurnFinished(true)

    const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.state).toBe('done')
    expect(record?.interrupted).toBe(true)
    expect(isPassiveCompletedHibernationEvidence(record!)).toBe(false)

    useAppStore.setState({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree[WORKTREE_ID]?.[0]
    expect(resumedTab?.launchAgent).toBe('codex')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.showSessionRestoredBanner).toBe(true)
  })

  it('is not respawned into a new tab once its pane is killed', () => {
    seedLiveLocalCodexPane()
    reportTurnFinished()

    // `orca terminal stop` / app death: the PTY and pane go, the record stays.
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched, 'a finished agent must never be respawned').toBe(0)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    // The orphaned record is retired rather than left queued for the next visit.
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('still holds its resume identity for a cold restore while its pane exists', () => {
    seedLiveLocalCodexPane()
    reportTurnFinished()

    // The pane survives (app relaunch restored the tab): #9454's crash-recovery
    // case. The record must NOT be cleared, or the pane cold-restores to a shell.
    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched, 'an owned pane resumes in place, never in a new tab').toBe(0)
    const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record, 'the pane still owns a record to cold-restore from').toBeDefined()
    expect(record?.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
  })
})
