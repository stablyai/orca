import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { findOriginalAiVaultSessionPane } from './ai-vault-original-pane'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const baseSession: AiVaultSession = {
  id: 'codex:session-1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Fix the pane focus',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/home/ada/.codex/session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: '2026-06-24T10:00:00.000Z',
  modifiedAt: '2026-06-24T10:00:00.000Z',
  messageCount: 2,
  totalTokens: 42,
  previewMessages: [],
  resumeCommand: "codex resume 'session-1'"
}

function makeTab(id = 'tab-1', worktreeId = 'wt-1') {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId = LEAF_ID) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: 'pty-1' }
  }
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { 'wt-1': [makeTab()] },
    terminalLayoutsByTabId: { 'tab-1': makeLayout() },
    ...overrides
  } as never
}

function makeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = makePaneKey('tab-1', LEAF_ID)
  return {
    state: 'working',
    prompt: 'continue',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    stateHistory: [],
    providerSession: { key: 'session_id', id: 'session-1' },
    ...overrides
  }
}

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

describe('findOriginalAiVaultSessionPane', () => {
  it('finds a live pane with a matching provider session', () => {
    const entry = makeEntry()

    const target = findOriginalAiVaultSessionPane(
      makeState({ agentStatusByPaneKey: { [entry.paneKey]: entry } }),
      baseSession
    )

    expect(target).toEqual({
      paneKey: entry.paneKey,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('finds a unique live pane by prompt when provider session is not known yet', () => {
    const entry = makeEntry({
      providerSession: undefined,
      prompt: 'Fix the pane focus'
    })

    const target = findOriginalAiVaultSessionPane(
      makeState({ agentStatusByPaneKey: { [entry.paneKey]: entry } }),
      baseSession
    )

    expect(target?.paneKey).toBe(entry.paneKey)
  })

  it('does not prompt-match when multiple panes are plausible', () => {
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const secondPaneKey = makePaneKey('tab-2', OTHER_LEAF_ID)
    const first = makeEntry({ paneKey: firstPaneKey, providerSession: undefined })
    const second = makeEntry({
      paneKey: secondPaneKey,
      tabId: 'tab-2',
      providerSession: undefined
    })

    const target = findOriginalAiVaultSessionPane(
      makeState({
        agentStatusByPaneKey: {
          [first.paneKey]: first,
          [second.paneKey]: second
        },
        tabsByWorktree: { 'wt-1': [makeTab('tab-1'), makeTab('tab-2')] },
        terminalLayoutsByTabId: {
          'tab-1': makeLayout(LEAF_ID),
          'tab-2': makeLayout(OTHER_LEAF_ID)
        }
      }),
      baseSession
    )

    expect(target).toBeNull()
  })

  it('does not return a target when the original leaf is gone', () => {
    const entry = makeEntry()

    const target = findOriginalAiVaultSessionPane(
      makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry },
        terminalLayoutsByTabId: { 'tab-1': makeLayout(OTHER_LEAF_ID) }
      }),
      baseSession
    )

    expect(target).toBeNull()
  })

  it('finds a retained completed pane when the tab and layout still exist', () => {
    const entry = makeEntry({ state: 'done' })

    const target = findOriginalAiVaultSessionPane(
      makeState({
        retainedAgentsByPaneKey: {
          [entry.paneKey]: {
            entry,
            worktreeId: 'wt-1',
            tab: makeTab(),
            agentType: 'codex',
            startedAt: 1
          }
        }
      }),
      baseSession
    )

    expect(target?.leafId).toBe(LEAF_ID)
  })

  it('finds a preserved sleeping pane from a matching session record', () => {
    const record = makeSleepingRecord()

    const target = findOriginalAiVaultSessionPane(
      makeState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } }),
      baseSession
    )

    expect(target?.paneKey).toBe(record.paneKey)
  })

  it('resolves legacy numeric pane keys through the current tab layout', () => {
    const record = makeSleepingRecord({ paneKey: 'tab-1:1' })

    const target = findOriginalAiVaultSessionPane(
      makeState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } }),
      baseSession
    )

    expect(target?.leafId).toBe(LEAF_ID)
  })
})
