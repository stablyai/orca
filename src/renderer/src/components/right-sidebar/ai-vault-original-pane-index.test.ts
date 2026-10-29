import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  buildAiVaultOriginalPaneIndex,
  createLazyAiVaultOriginalPaneIndex,
  findAiVaultSessionLiveStateInIndex,
  findOriginalAiVaultSessionPaneInIndex
} from './ai-vault-original-pane-index'
import {
  findAiVaultSessionLiveState,
  findOriginalAiVaultSessionPane
} from './ai-vault-original-pane'

const SESSION: AiVaultSession = {
  id: 'codex:target-session',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'target-session',
  title: 'Target session',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/tmp/target-session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: '2026-07-10T00:00:00.000Z',
  modifiedAt: '2026-07-10T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 1,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "codex resume 'target-session'",
  subagent: null
}

function countedRecord<T>(count: number, makeValue: (index: number) => T) {
  const reads = { value: 0 }
  const record: Record<string, T> = {}
  for (let index = 0; index < count; index += 1) {
    Object.defineProperty(record, `entry-${index}`, {
      enumerable: true,
      get: () => {
        reads.value += 1
        return makeValue(index)
      }
    })
  }
  return { reads, record }
}

function unrelatedEntry(index: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: `Other task ${index}`,
    updatedAt: index,
    stateStartedAt: index,
    agentType: 'claude',
    paneKey: `other-tab-${index}:11111111-1111-4111-8111-111111111111`,
    tabId: `other-tab-${index}`,
    worktreeId: 'other-worktree',
    stateHistory: [],
    providerSession: { key: 'session_id', id: `other-session-${index}` }
  }
}

describe('AI Vault original-pane index', () => {
  it('builds lazily on the first lookup and shares one index across callbacks', () => {
    const live = countedRecord(500, unrelatedEntry)
    const retained = countedRecord(500, (index) => ({
      entry: unrelatedEntry(index),
      worktreeId: 'other-worktree',
      tab: { id: `other-tab-${index}` },
      agentType: 'claude',
      startedAt: index
    }))
    const sleeping = countedRecord(500, (index) => ({
      paneKey: `other-tab-${index}:11111111-1111-4111-8111-111111111111`,
      tabId: `other-tab-${index}`,
      worktreeId: 'other-worktree',
      agent: 'claude',
      providerSession: { key: 'session_id', id: `other-session-${index}` },
      prompt: `Other task ${index}`,
      state: 'done',
      capturedAt: index,
      updatedAt: index,
      origin: 'live'
    }))
    const getIndex = createLazyAiVaultOriginalPaneIndex({
      agentStatusByPaneKey: live.record,
      retainedAgentsByPaneKey: retained.record,
      sleepingAgentSessionsByPaneKey: sleeping.record,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as never)

    expect(live.reads.value + retained.reads.value + sleeping.reads.value).toBe(0)
    expect(findAiVaultSessionLiveStateInIndex(getIndex(), SESSION)).toBeNull()
    expect(live.reads.value + retained.reads.value + sleeping.reads.value).toBe(1_500)
    expect(findOriginalAiVaultSessionPaneInIndex(getIndex(), SESSION)).toBeNull()
    expect(live.reads.value + retained.reads.value + sleeping.reads.value).toBe(1_500)
  })

  it('builds once instead of rescanning every agent collection for every visible row', () => {
    const live = countedRecord(500, unrelatedEntry)
    const retained = countedRecord(500, (index) => ({
      entry: unrelatedEntry(index),
      worktreeId: 'other-worktree',
      tab: { id: `other-tab-${index}` },
      agentType: 'claude',
      startedAt: index
    }))
    const sleeping = countedRecord(500, (index) => ({
      paneKey: `other-tab-${index}:11111111-1111-4111-8111-111111111111`,
      tabId: `other-tab-${index}`,
      worktreeId: 'other-worktree',
      agent: 'claude',
      providerSession: { key: 'session_id', id: `other-session-${index}` },
      prompt: `Other task ${index}`,
      state: 'done',
      capturedAt: index,
      updatedAt: index,
      origin: 'live'
    }))
    const state = {
      agentStatusByPaneKey: live.record,
      retainedAgentsByPaneKey: retained.record,
      sleepingAgentSessionsByPaneKey: sleeping.record,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as never

    const index = buildAiVaultOriginalPaneIndex(state)
    expect(live.reads.value + retained.reads.value + sleeping.reads.value).toBe(1_500)

    live.reads.value = 0
    retained.reads.value = 0
    sleeping.reads.value = 0
    for (let row = 0; row < 20; row += 1) {
      expect(findOriginalAiVaultSessionPaneInIndex(index, SESSION)).toBeNull()
      expect(findAiVaultSessionLiveStateInIndex(index, SESSION)).toBeNull()
    }
    expect(live.reads.value + retained.reads.value + sleeping.reads.value).toBe(0)
  })

  it('preserves provider, prompt-fallback, retained, sleeping, and missing matches', () => {
    const leafIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444'
    ]
    const tabs = leafIds.map((_, index) => ({
      id: `tab-${index + 1}`,
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: index
    }))
    const layouts = Object.fromEntries(
      leafIds.map((leafId, index) => [
        `tab-${index + 1}`,
        {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: `pty-${index + 1}` }
        }
      ])
    )
    const liveDirect = {
      ...unrelatedEntry(1),
      agentType: 'codex',
      paneKey: `tab-1:${leafIds[0]}`,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      state: 'blocked',
      providerSession: { key: 'session_id', id: 'live-direct' }
    } as AgentStatusEntry
    const livePrompt = {
      ...unrelatedEntry(2),
      agentType: 'codex',
      paneKey: `tab-2:${leafIds[1]}`,
      tabId: 'tab-2',
      worktreeId: 'wt-1',
      prompt: 'Unique prompt match that is long enough',
      providerSession: undefined
    } as AgentStatusEntry
    const retainedEntry = {
      ...unrelatedEntry(3),
      agentType: 'codex',
      paneKey: `tab-3:${leafIds[2]}`,
      tabId: 'tab-3',
      worktreeId: 'wt-1',
      providerSession: { key: 'session_id', id: 'retained-direct' }
    } as AgentStatusEntry
    const state = {
      agentStatusByPaneKey: {
        [liveDirect.paneKey]: liveDirect,
        [livePrompt.paneKey]: livePrompt
      },
      retainedAgentsByPaneKey: {
        [retainedEntry.paneKey]: {
          entry: retainedEntry,
          worktreeId: 'wt-1',
          tab: tabs[2],
          agentType: 'codex',
          startedAt: 1
        }
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-4:1': {
          paneKey: 'tab-4:1',
          tabId: 'tab-4',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sleeping-direct' },
          prompt: 'Sleeping',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      },
      tabsByWorktree: { 'wt-1': tabs },
      terminalLayoutsByTabId: layouts
    } as never
    const index = buildAiVaultOriginalPaneIndex(state)
    const sessions = [
      { ...SESSION, sessionId: 'live-direct' },
      {
        ...SESSION,
        sessionId: 'prompt-only',
        title: 'Unique prompt match that is long enough'
      },
      { ...SESSION, sessionId: 'retained-direct' },
      { ...SESSION, sessionId: 'sleeping-direct' },
      { ...SESSION, sessionId: 'missing' }
    ]

    for (const session of sessions) {
      expect(findOriginalAiVaultSessionPaneInIndex(index, session)).toEqual(
        findOriginalAiVaultSessionPane(state, session)
      )
      expect(findAiVaultSessionLiveStateInIndex(index, session)).toBe(
        findAiVaultSessionLiveState(state, session)
      )
    }
  })
})
