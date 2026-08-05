import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { OriginalPaneState } from './ai-vault-original-pane'
import { findLiveAiVaultSessionPane } from './ai-vault-resume-focus-existing-pane'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    filePath: '/home/user/.claude/projects/proj/sess-1.jsonl',
    title: 'session',
    updatedAt: 1,
    ...overrides
  } as AiVaultSession
}

function makeState(overrides: Partial<OriginalPaneState> = {}): OriginalPaneState {
  return {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'ssh:target-a@@pty-3' }
      }
    },
    ...overrides
  } as never
}

describe('findLiveAiVaultSessionPane', () => {
  it('returns the pane of a live agent-status entry with an exact provider session match', () => {
    const state = makeState({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agentType: 'claude',
          state: 'working',
          providerSession: { key: 'session_id', id: 'sess-1' }
        }
      }
    } as never)

    expect(findLiveAiVaultSessionPane(state, makeSession())).toMatchObject({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('never matches on prompt heuristics alone', () => {
    const state = makeState({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agentType: 'claude',
          state: 'working',
          providerSession: undefined,
          firstPrompt: 'session',
          latestPrompt: 'session'
        }
      }
    } as never)

    expect(findLiveAiVaultSessionPane(state, makeSession())).toBeNull()
  })

  it('returns the pane of a non-passive sleeping record', () => {
    const state = makeState({
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'sess-1' },
          state: 'working',
          origin: 'quit',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as never)

    expect(findLiveAiVaultSessionPane(state, makeSession())).toMatchObject({ tabId: 'tab-1' })
  })

  it('skips passive completed-hibernation records — history panes hold no process', () => {
    const state = makeState({
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'sess-1' },
          state: 'done',
          origin: 'hibernation',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as never)

    expect(findLiveAiVaultSessionPane(state, makeSession())).toBeNull()
  })
})
