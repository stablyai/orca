import { expect, it } from 'vitest'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { makeAgentEntry, makeUnifiedTab } from '../worktree-jump-palette-test-fixtures'
import {
  paletteTranscriptTabKey,
  resolvePaletteTranscriptEligibleTabs,
  resolvePaletteTranscriptMatches
} from '../worktree-jump-palette-transcript-matches'
import { paletteTranscriptEligibility } from './palette-transcript-eligibility'
import {
  buildPaletteTranscriptIndex,
  type PaletteTranscriptState
} from './palette-transcript-structured-tabs'

function nativeState(
  sessions: {
    id: string
    sessionId: string
    agent?: AiVaultAgent
    executionHostId?: ExecutionHostId
  }[]
): PaletteTranscriptState {
  const tabs: Tab[] = sessions.map(({ id, executionHostId }) => ({
    ...makeUnifiedTab(id, 'workspace', `entity-${id}`, id),
    contentType: 'agent-session',
    ...(executionHostId ? { executionHostId } : {})
  }))
  return {
    agentStatusByPaneKey: Object.fromEntries(
      sessions.map(({ id, sessionId, agent }) => {
        const paneKey = structuredAgentSessionPaneKey(id, `entity-${id}`)
        return [
          paneKey,
          makeAgentEntry(id, 'done', 0, {
            paneKey,
            tabId: id,
            worktreeId: 'workspace',
            agentType: agent ?? 'claude',
            providerSession: { key: 'session_id', id: sessionId }
          })
        ]
      })
    ),
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: { workspace: tabs }
  }
}

it('reuses one native index for eligibility, tab reservation and a production-sized hit batch', () => {
  const sessions = Array.from({ length: 320 }, (_, index) => ({
    id: `chat-${index}`,
    sessionId: ` provider:[${index}] `
  }))
  const state = nativeState(sessions)
  const unifiedTabs = state.unifiedTabsByWorktree
  let nativeReads = 0
  Object.defineProperty(state, 'unifiedTabsByWorktree', {
    get() {
      nativeReads += 1
      return unifiedTabs
    }
  })
  const index = buildPaletteTranscriptIndex(state)
  expect(paletteTranscriptEligibility(state, index)?.providers).toEqual(
    sessions.map(({ sessionId }) => ({ agent: 'claude', sessionId }))
  )
  expect(resolvePaletteTranscriptEligibleTabs(state, index)).toEqual(
    new Set(sessions.map(({ id }) => paletteTranscriptTabKey('workspace', id)))
  )
  const hits = sessions.toReversed().map(({ sessionId }) => ({
    ...searchHit(),
    agent: 'claude' as const,
    sessionId
  }))
  expect(
    resolvePaletteTranscriptMatches(hits, state, '', undefined, index).map((match) => [
      match.tabId,
      match.ordinal
    ])
  ).toEqual(sessions.toReversed().map(({ id }, ordinal) => [id, ordinal]))
  expect(nativeReads).toBe(1)
})

it('matches exact provider IDs within their agent and retains every resumed native tab', () => {
  const state = nativeState([
    { id: 'claude-a', sessionId: ' session:[same] ' },
    { id: 'claude-b', sessionId: ' session:[same] ' },
    { id: 'codex', sessionId: ' session:[same] ', agent: 'codex' },
    { id: 'trimmed', sessionId: 'session:[same]' }
  ])
  const index = buildPaletteTranscriptIndex(state)
  const hits = [
    { ...searchHit(), agent: 'codex' as const, sessionId: ' session:[same] ' },
    { ...searchHit(), agent: 'claude' as const, sessionId: ' session:[same] ' },
    { ...searchHit(), agent: 'claude' as const, sessionId: 'SESSION:[SAME]' }
  ]
  expect(
    resolvePaletteTranscriptMatches(hits, state, '', undefined, index).map((match) => [
      match.tabId,
      match.ordinal
    ])
  ).toEqual([
    ['codex', 0],
    ['claude-a', 1],
    ['claude-b', 1]
  ])
  expect(paletteTranscriptEligibility(state, index)?.providers).toEqual([
    { agent: 'claude', sessionId: ' session:[same] ' },
    { agent: 'codex', sessionId: ' session:[same] ' },
    { agent: 'claude', sessionId: 'session:[same]' }
  ])
})

it('rejects duplicate, closed and mismatched native identities in every index consumer', () => {
  const state = nativeState([
    { id: 'valid', sessionId: 'valid-session' },
    { id: 'duplicate', sessionId: 'duplicate-session' },
    { id: 'duplicate', sessionId: 'duplicate-session' },
    { id: 'closed', sessionId: 'closed-session' },
    { id: 'wrong-tab', sessionId: 'wrong-tab-session' },
    { id: 'wrong-workspace', sessionId: 'wrong-workspace-session' },
    { id: 'empty-provider', sessionId: '' },
    { id: 'oversized-provider', sessionId: 'x'.repeat(513) },
    { id: 'remote', sessionId: 'remote-session', executionHostId: 'runtime:remote' }
  ])
  state.unifiedTabsByWorktree = {
    workspace: state.unifiedTabsByWorktree?.workspace.filter((tab) => tab.id !== 'closed') ?? []
  }
  state.agentStatusByPaneKey[structuredAgentSessionPaneKey('wrong-tab', 'entity-wrong-tab')].tabId =
    'different-tab'
  state.agentStatusByPaneKey[
    structuredAgentSessionPaneKey('wrong-workspace', 'entity-wrong-workspace')
  ].worktreeId = 'different-workspace'
  const index = buildPaletteTranscriptIndex(state)
  expect(paletteTranscriptEligibility(state, index)).toEqual({
    providers: [{ agent: 'claude', sessionId: 'valid-session' }],
    prompts: []
  })
  expect(resolvePaletteTranscriptEligibleTabs(state, index)).toEqual(
    new Set([paletteTranscriptTabKey('workspace', 'valid')])
  )
  const hits = Object.values(state.agentStatusByPaneKey).map((entry) => ({
    ...searchHit(),
    agent: 'claude' as const,
    sessionId: entry.providerSession?.id ?? ''
  }))
  expect(resolvePaletteTranscriptMatches(hits, state, '', undefined, index)).toMatchObject([
    { tabId: 'valid', ordinal: 0 }
  ])
})

it('scopes native provider lookup and reservations to the prepared execution host', () => {
  const state = nativeState([
    { id: 'local', sessionId: 'same' },
    { id: 'remote', sessionId: 'same', executionHostId: 'runtime:remote' }
  ])
  const remoteState: PaletteTranscriptState = {
    ...state,
    unifiedTabsByWorktree: {
      workspace: state.unifiedTabsByWorktree?.workspace.filter((tab) => tab.id === 'remote') ?? []
    }
  }
  const index = buildPaletteTranscriptIndex(remoteState, 'runtime:remote')
  expect(paletteTranscriptEligibility(remoteState, index)?.providers).toEqual([
    { agent: 'claude', sessionId: 'same' }
  ])
  expect(resolvePaletteTranscriptEligibleTabs(remoteState, index)).toEqual(
    new Set([paletteTranscriptTabKey('workspace', 'remote', 'runtime:remote')])
  )
  const localHit = { ...searchHit(), agent: 'claude' as const, sessionId: 'same' }
  const remoteHit = { ...localHit, executionHostId: 'runtime:remote' as const }
  expect(resolvePaletteTranscriptMatches([remoteHit], state)).toEqual([])
  expect(
    resolvePaletteTranscriptMatches([localHit, remoteHit], remoteState, '', undefined, index)
  ).toMatchObject([{ executionHostId: 'runtime:remote', tabId: 'remote', ordinal: 1 }])
})
