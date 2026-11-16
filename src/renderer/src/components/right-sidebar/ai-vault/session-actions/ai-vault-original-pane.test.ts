import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  buildAiVaultOriginalPaneIndex,
  findOriginalAiVaultSessionPaneInIndex
} from './ai-vault-original-pane-index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { type OriginalPaneState, findOriginalAiVaultSessionPane } from './ai-vault-original-pane'

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
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "codex resume 'session-1'",
  subagent: null
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

function makeState(overrides: Partial<OriginalPaneState> = {}): OriginalPaneState {
  return {
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    agentConversationsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { 'wt-1': [makeTab()] },
    terminalLayoutsByTabId: { 'tab-1': makeLayout() },
    ...overrides
  }
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

describe('findOriginalAiVaultSessionPane', () => {
  it('does not return a target when the original leaf is gone', () => {
    const entry = makeEntry()

    const target = findOriginalAiVaultSessionPane(
      makeState({
        agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [entry.paneKey]: entry })),
        terminalLayoutsByTabId: { 'tab-1': makeLayout(OTHER_LEAF_ID) }
      }),
      baseSession
    )

    expect(target).toBeNull()
  })
})

it.each([true, false])(
  'forgets the preceding original-pane target after an unidentified successor (provider known: %s)',
  (known) => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab()] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() }
    })
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'codex', prompt: baseSession.title },
        undefined,
        { updatedAt: 1000 },
        { worktreeId: 'wt-1' },
        known ? { providerSession: { key: 'session_id', id: 'session-1' } } : undefined
      )
    store.getState().removeAgentStatus(paneKey)
    expect(findOriginalAiVaultSessionPane(store.getState(), baseSession)?.paneKey).toBe(paneKey)
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', agentType: 'codex', prompt: 'Current task' },
        undefined,
        { updatedAt: 2000 },
        { worktreeId: 'wt-1' }
      )
    store.getState().removeAgentStatus(paneKey)
    expect(findOriginalAiVaultSessionPane(store.getState(), baseSession)).toBeNull()
    expect(
      findOriginalAiVaultSessionPaneInIndex(
        buildAiVaultOriginalPaneIndex(store.getState()),
        baseSession
      )
    ).toBeNull()
    const current = { ...baseSession, sessionId: 'session-next', title: 'Current task' }
    expect(findOriginalAiVaultSessionPane(store.getState(), current)?.paneKey).toBe(paneKey)
    store
      .getState()
      .recordAgentProviderSession(paneKey, 'codex', { key: 'session_id', id: 'session-next' })
    expect(findOriginalAiVaultSessionPane(store.getState(), baseSession)).toBeNull()
    expect(findOriginalAiVaultSessionPane(store.getState(), current)?.paneKey).toBe(paneKey)
  }
)
