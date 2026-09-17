import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { OriginalPaneState } from './ai-vault-original-pane'
import {
  buildAiVaultOriginalPaneIndex,
  resolveAiVaultSessionListTitle
} from './ai-vault-original-pane-index'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const session: AiVaultSession = {
  id: 'codex:session-1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'First user prompt',
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

function makeTab(customTitle: string | null, id = 'tab-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Codex working',
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(): NonNullable<OriginalPaneState['terminalLayoutsByTabId'][string]> {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
  }
}

function makeState(overrides: Partial<OriginalPaneState> = {}): OriginalPaneState {
  return {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { 'wt-1': [makeTab(null)] },
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

describe('AI Vault session list custom titles', () => {
  it('uses a live tab rename ahead of the scanner title', () => {
    const entry = makeEntry()
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry },
        tabsByWorktree: { 'wt-1': [makeTab('Payments spike')] }
      })
    )

    expect(resolveAiVaultSessionListTitle(index, session)).toBe('Payments spike')
  })

  it('keeps the scanner title when the live tab has no rename', () => {
    const entry = makeEntry()
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry }
      })
    )

    expect(resolveAiVaultSessionListTitle(index, session)).toBe('First user prompt')
  })

  it('does not let a retained rename replace a live tab that was un-renamed', () => {
    const entry = makeEntry({ state: 'done' })
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry },
        retainedAgentsByPaneKey: {
          [entry.paneKey]: {
            entry,
            worktreeId: 'wt-1',
            tab: makeTab('Stale retained name'),
            agentType: 'codex',
            startedAt: 1
          }
        }
      })
    )

    expect(resolveAiVaultSessionListTitle(index, session)).toBe('First user prompt')
  })

  it('uses a retained tab rename after the live tab is gone', () => {
    const entry = makeEntry({ state: 'done' })
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        retainedAgentsByPaneKey: {
          [entry.paneKey]: {
            entry,
            worktreeId: 'wt-1',
            tab: makeTab('Retained rename'),
            agentType: 'codex',
            startedAt: 1
          }
        },
        tabsByWorktree: {}
      })
    )

    expect(resolveAiVaultSessionListTitle(index, session)).toBe('Retained rename')
  })

  it('uses a sleeping tab rename when no live or retained tab claims the session', () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: makePaneKey('tab-1', LEAF_ID),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: 'continue',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live'
    }
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
        tabsByWorktree: { 'wt-1': [makeTab('Sleeping rename')] }
      })
    )

    expect(resolveAiVaultSessionListTitle(index, session)).toBe('Sleeping rename')
  })

  it('does not apply a parent tab rename to a subagent row', () => {
    const entry = makeEntry()
    const index = buildAiVaultOriginalPaneIndex(
      makeState({
        agentStatusByPaneKey: { [entry.paneKey]: entry },
        tabsByWorktree: { 'wt-1': [makeTab('Parent rename')] }
      })
    )

    expect(
      resolveAiVaultSessionListTitle(index, {
        ...session,
        title: 'Task: run tests',
        subagent: { parentSessionId: 'session-1', agentType: 'Explore', status: null }
      })
    ).toBe('Task: run tests')
  })
})
