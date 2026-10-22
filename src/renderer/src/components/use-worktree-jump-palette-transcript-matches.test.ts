// @vitest-environment happy-dom

import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

import { paletteTranscriptEligibility } from './cmd-j/palette-transcript-eligibility'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { searchHit, searchResults } from '../../../shared/ai-vault-search-test-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useWorktreeJumpPaletteTranscriptMatches } from './use-worktree-jump-palette-transcript-matches'
import { EMPTY_PALETTE_FILTER } from './cmd-j/palette-filter'
import {
  LEAF_ID,
  makeAgentEntry,
  makeTerminalTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'
import type { PaletteFilterModel } from './cmd-j/palette-filter-options'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'

const { search } = vi.hoisted(() => ({ search: vi.fn() }))
const filterModel: PaletteFilterModel = {
  hosts: [],
  repositories: [],
  repoIdsByProjectKey: new Map(),
  hostIdsByRepoId: new Map(),
  repoById: new Map(),
  defaultHostId: 'local'
}
vi.mock('./right-sidebar/use-ai-vault-search', () => ({
  useAiVaultSearchPages: (requests: { request: unknown; scope: string }[]) => ({
    pages: requests.map(({ request, scope }) => ({ ...search(request, scope), request, scope }))
  }),
  aiVaultSearchNeedsLocalConsent: () => false
}))

afterEach(() => {
  cleanup()
  search.mockReset()
})

function transcriptInput(
  hit: AiVaultSearchHit
): Parameters<typeof useWorktreeJumpPaletteTranscriptMatches>[0] {
  return {
    settings: null,
    visible: true,
    query: 'refresh',
    deferredQuery: 'refresh',
    filter: EMPTY_PALETTE_FILTER,
    filterModel,
    filterPredicate: null,
    workspaces: [makeWorktree('workspace', 'Workspace')],
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {
      [makePaneKey('terminal', LEAF_ID)]: makeAgentEntry('terminal', 'done', 0, {
        agentType: hit.agent,
        tabId: 'terminal',
        worktreeId: 'workspace',
        providerSession: { key: 'session_id', id: hit.sessionId }
      })
    },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { workspace: [makeTerminalTab('terminal', 'workspace', 'Conversation')] },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    }
  }
}

const literalHit = () => ({
  ...searchHit(),
  evidence: {
    role: 'assistant' as const,
    timestamp: null,
    snippet: 'a [[refresh]] here',
    originalExcerpt: { text: 'a refresh here' }
  }
})

it('keeps measured evidence through pane updates while invalidating it on query or response changes', () => {
  const hit = literalHit()
  search.mockReturnValue({
    hits: [hit],
    response: { ...searchResults(), eligibleSessionsApplied: true, forksPreserved: true },
    loading: false
  })
  const initialProps = transcriptInput(hit)
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps })
  const proof = result.current.transcriptMeasurement.candidates[0]?.windows[0]
  expect(proof).toBeDefined()
  if (!proof) {
    throw new Error('Expected literal proof')
  }
  act(() => result.current.transcriptMeasurement.onFits(new Map([[0, proof]]), 'display'))
  expect(result.current.transcriptMatches[0]?.complete).toBe(true)

  act(() => result.current.transcriptMeasurement.onFits(new Map(), 'display'))
  expect(result.current.transcriptMatches[0]?.complete).toBe(false)
  act(() => result.current.transcriptMeasurement.onFits(new Map([[0, proof]]), 'display'))
  expect(result.current.transcriptMatches[0]?.complete).toBe(true)

  rerender({ ...initialProps, agentStatusByPaneKey: { ...initialProps.agentStatusByPaneKey } })
  expect(result.current.transcriptMatches[0]?.complete).toBe(true)

  search.mockReturnValue({
    hits: [{ ...hit, evidence: { ...hit.evidence, originalExcerpt: undefined } }],
    response: { ...searchResults(), eligibleSessionsApplied: true, forksPreserved: true },
    loading: false
  })
  rerender(initialProps)
  expect(result.current.transcriptMatches).toMatchObject([{ complete: false }])

  rerender({ ...initialProps, query: 'race' })
  expect(result.current.transcriptMatches).toEqual([])
})

it('retains acknowledged evidence during eligibility refresh, dropping closed panes and raw-input generations immediately', () => {
  const hit = literalHit()
  const initialProps = transcriptInput(hit)
  search.mockReturnValue({
    hits: [hit],
    response: { ...searchResults(), eligibleSessionsApplied: true, forksPreserved: true },
    loading: false
  })
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps })
  const proof = result.current.transcriptMeasurement.candidates[0]?.windows[0]
  if (!proof) {
    throw new Error('Missing proof')
  }
  act(() => result.current.transcriptMeasurement.onFits(new Map([[0, proof]]), 'display'))
  const changedEligibility = {
    ...initialProps,
    agentStatusByPaneKey: {
      ...initialProps.agentStatusByPaneKey,
      [makePaneKey('new-terminal', LEAF_ID)]: makeAgentEntry('new-terminal', 'done', 1, {
        agentType: hit.agent,
        tabId: 'new-terminal',
        worktreeId: 'workspace',
        providerSession: { key: 'session_id', id: 'new-session' }
      })
    },
    tabsByWorktree: {
      workspace: [
        ...(initialProps.tabsByWorktree.workspace ?? []),
        makeTerminalTab('new-terminal', 'workspace', 'New conversation')
      ]
    },
    terminalLayoutsByTabId: {
      ...initialProps.terminalLayoutsByTabId,
      'new-terminal': {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    }
  }
  search.mockReturnValue({ hits: [], response: null, loading: true })
  rerender(changedEligibility)
  expect(result.current.transcriptMatches[0]?.complete).toBe(true)
  rerender({ ...changedEligibility, tabsByWorktree: {} })
  expect(result.current.transcriptMatches).toEqual([])
  rerender({ ...changedEligibility, query: 'race' })
  expect(result.current.transcriptMatches).toEqual([])
})

it('builds eligibility from the current local workspace filter and ignores another workspace’s colliding remote tab id', () => {
  const hit = literalHit()
  const initialProps = transcriptInput(hit)
  const otherWorkspace = makeWorktree('other', 'Other', { repoId: 'other-repo' })
  const remoteTab = {
    id: 'remote-tab',
    entityId: 'terminal',
    worktreeId: 'other',
    contentType: 'terminal' as const,
    executionHostId: 'ssh:remote' as const,
    groupId: 'remote',
    label: '',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  search.mockReturnValue({ hits: [], response: null, loading: false })
  const props = {
    ...initialProps,
    workspaces: [...initialProps.workspaces, otherWorkspace],
    unifiedTabsByWorktree: { other: [remoteTab] },
    tabsByWorktree: {
      ...initialProps.tabsByWorktree,
      other: [makeTerminalTab('terminal', 'other', 'Remote')]
    }
  }
  const { rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps: props })
  expect(search.mock.lastCall?.[0]?.eligibleSessions.providers).toEqual([
    { agent: hit.agent, sessionId: hit.sessionId }
  ])
  const blocked = {
    matchesWorktree: () => false,
    matchesProjectRowKey: () => false,
    matchesGroupHostId: () => false
  }
  rerender({ ...props, filterPredicate: blocked })
  expect(search.mock.lastCall?.[0]).toBeNull()
})

it('keeps exact provider eligibility when production-sized legacy prompt history exceeds the budget', () => {
  const input = transcriptInput(literalHit())
  const provider = input.agentStatusByPaneKey[makePaneKey('terminal', LEAF_ID)]
  const entries = Array.from({ length: 70 }, (_, pane) => {
    const tabId = `legacy-${pane}`
    const prompt = (history: number) => `${pane}-${history}: `.padEnd(200, 'x')
    return makeAgentEntry(tabId, 'done', 0, {
      agentType: 'claude',
      tabId,
      worktreeId: 'workspace',
      providerSession: undefined,
      prompt: prompt(0),
      stateHistory: Array.from({ length: 20 }, (_, history) => ({
        state: 'done' as const,
        startedAt: 0,
        prompt: prompt(history)
      }))
    })
  })
  const state = {
    ...input,
    agentStatusByPaneKey: Object.fromEntries(
      [provider, ...entries].map((entry) => [entry.paneKey, entry])
    ),
    tabsByWorktree: {
      workspace: [
        input.tabsByWorktree.workspace[0],
        ...entries.map((entry) => makeTerminalTab(entry.tabId ?? '', 'workspace', 'Legacy'))
      ]
    },
    terminalLayoutsByTabId: Object.fromEntries(
      [provider, ...entries].map((entry) => [entry.tabId, input.terminalLayoutsByTabId.terminal])
    )
  }
  expect(paletteTranscriptEligibility(state)).toEqual({
    providers: [{ agent: provider.agentType, sessionId: provider.providerSession?.id }],
    prompts: []
  })
})

it('does not request or classify transcript evidence for an oversized pasted query', () => {
  search.mockReturnValue({ hits: [], response: null, loading: false })
  const query = 'é'.repeat(2048)
  const { result } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
    initialProps: { ...transcriptInput(literalHit()), query, deferredQuery: query }
  })
  expect(search.mock.calls[0]?.[0]).toBeNull()
  expect(result.current.transcriptMeasurement.candidates).toEqual([])
  expect(result.current.transcriptSearchEnabled).toBe(false)
})

it('searches native chat provider sessions without a terminal layout and drops remote or closed chats', () => {
  const hit = {
    ...literalHit(),
    evidence: {
      role: 'user' as const,
      timestamp: null,
      snippet: 'Browser annotation (v1.4.217)',
      originalExcerpt: { text: 'Browser annotation (v1.4.217)' }
    }
  }
  search.mockReturnValue({
    hits: [hit],
    response: { ...searchResults(), eligibleSessionsApplied: true, forksPreserved: true },
    loading: false
  })
  const tab = {
    id: 'native-chat',
    entityId: 'structured-session',
    contentType: 'agent-session' as const,
    worktreeId: 'workspace',
    groupId: 'group',
    label: 'Browser annotation',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const input: Parameters<typeof useWorktreeJumpPaletteTranscriptMatches>[0] = {
    ...transcriptInput(hit),
    query: '217',
    deferredQuery: '217',
    unifiedTabsByWorktree: { workspace: [tab] },
    agentStatusByPaneKey: {
      [paneKey]: makeAgentEntry(tab.id, 'done', 0, {
        paneKey,
        tabId: tab.id,
        worktreeId: tab.worktreeId,
        agentType: hit.agent,
        providerSession: { key: 'session_id', id: hit.sessionId }
      })
    },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
    initialProps: input
  })
  expect(search.mock.lastCall?.[0]?.eligibleSessions.providers).toEqual([
    { agent: hit.agent, sessionId: hit.sessionId }
  ])
  expect(result.current.transcriptMeasurement.candidates).toMatchObject([
    { worktreeId: 'workspace', tabId: tab.id, windows: [expect.anything(), expect.anything()] }
  ])
  expect(result.current.transcriptEligibleTabs.size).toBe(1)
  rerender({
    ...input,
    unifiedTabsByWorktree: { workspace: [{ ...tab, executionHostId: 'runtime:remote' }] }
  })
  expect(search.mock.lastCall?.[0]).toBeNull()
  expect(result.current.transcriptMeasurement.candidates).toEqual([])
  rerender({ ...input, unifiedTabsByWorktree: { workspace: [] } })
  expect(search.mock.lastCall?.[0]).toBeNull()
})
