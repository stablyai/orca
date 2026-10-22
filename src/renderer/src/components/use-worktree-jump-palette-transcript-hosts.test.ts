// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { searchHit, searchResults } from '../../../shared/ai-vault-search-test-fixture'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../shared/ai-vault-search-types'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import { useWorktreeJumpPaletteTranscriptMatches } from './use-worktree-jump-palette-transcript-matches'
import { EMPTY_PALETTE_FILTER } from './cmd-j/palette-filter'
import { buildPaletteFilterModel } from './cmd-j/palette-filter-options'
import {
  LEAF_ID,
  makeAgentEntry,
  makeTerminalTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

const searchSessions =
  vi.fn<
    (request: AiVaultSearchRequest, scope?: ExecutionHostScope) => Promise<AiVaultSearchResponse>
  >()

function response(
  scope: ExecutionHostScope = 'local',
  sessionId = 'shared'
): AiVaultSearchResponse {
  return {
    ...searchResults(),
    eligibleSessionsApplied: true,
    forksPreserved: true,
    hits: [
      {
        ...searchHit(),
        executionHostId: scope,
        sessionId,
        evidence: {
          role: 'assistant',
          timestamp: null,
          snippet: 'a [[refresh]] here',
          originalExcerpt: { text: 'a refresh here' }
        }
      }
    ]
  }
}

function input(
  localIndexEnabled = true
): Parameters<typeof useWorktreeJumpPaletteTranscriptMatches>[0] {
  const workspaces = [
    makeWorktree('local-workspace', 'Local'),
    makeWorktree('remote-workspace', 'Remote', { hostId: 'runtime:remote' }),
    makeWorktree('folder:remote-folder', 'Folder', {
      hostId: 'local',
      runtimeOwnerEnvironmentId: 'folder-host'
    })
  ]
  const native: Tab = {
    id: 'native',
    entityId: 'native-session',
    worktreeId: workspaces[2].id,
    contentType: 'agent-session',
    groupId: 'group',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    executionHostId: 'runtime:folder-host'
  }
  const nativePane = structuredAgentSessionPaneKey(native.id, native.entityId)
  return {
    settings: {
      ...getDefaultSettings('/home/test'),
      aiVaultSearch: { enabled: localIndexEnabled, historyDays: null }
    },
    visible: true,
    query: 'refresh',
    deferredQuery: 'refresh',
    filter: EMPTY_PALETTE_FILTER,
    filterPredicate: null,
    filterModel: buildPaletteFilterModel({
      repos: [],
      worktrees: workspaces,
      hostOptions: [],
      projects: [],
      projectHostSetups: []
    }),
    workspaces,
    unifiedTabsByWorktree: { [native.worktreeId]: [native] },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: Object.fromEntries(
      workspaces
        .slice(0, 2)
        .map((workspace, index) => [
          workspace.id,
          [makeTerminalTab(`terminal-${index}`, workspace.id, 'Conversation')]
        ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      [0, 1].map((index) => [
        `terminal-${index}`,
        { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID, expandedLeafId: null }
      ])
    ),
    agentStatusByPaneKey: {
      ...Object.fromEntries(
        workspaces.slice(0, 2).map((workspace, index) => {
          const tabId = `terminal-${index}`
          return [
            makePaneKey(tabId, LEAF_ID),
            makeAgentEntry(tabId, 'done', 0, {
              agentType: 'codex',
              tabId,
              worktreeId: workspace.id,
              providerSession: { key: 'session_id', id: 'shared' }
            })
          ]
        })
      ),
      [nativePane]: makeAgentEntry(native.id, 'done', 0, {
        paneKey: nativePane,
        tabId: native.id,
        worktreeId: native.worktreeId,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'shared' }
      })
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  searchSessions.mockReset().mockImplementation(async (_request, scope) => response(scope))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, aiVault: { searchSessions } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const debounce = () => act(async () => vi.advanceTimersByTimeAsync(120))

it('queries each eligible owner and resolves identical provider IDs only to that host’s native or terminal tabs', async () => {
  const { result } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps: input() })
  await debounce()
  expect(searchSessions.mock.calls.map(([, scope]) => scope).sort()).toEqual([
    'local',
    'runtime:folder-host',
    'runtime:remote'
  ])
  expect(result.current.transcriptMeasurement.candidates).toMatchObject([
    { worktreeId: 'local-workspace', tabId: 'terminal-0', ordinal: 0 },
    {
      executionHostId: 'runtime:folder-host',
      worktreeId: 'folder:remote-folder',
      tabId: 'native',
      ordinal: 1
    },
    {
      executionHostId: 'runtime:remote',
      worktreeId: 'remote-workspace',
      tabId: 'terminal-1',
      ordinal: 2
    }
  ])
  const candidates = result.current.transcriptMeasurement.candidates
  act(() =>
    result.current.transcriptMeasurement.onFits(
      new Map(candidates.map((candidate) => [candidate.ordinal, candidate.windows[0]])),
      'display'
    )
  )
  expect(result.current.transcriptMatches.filter((match) => match.complete)).toHaveLength(3)
  expect(result.current.transcriptEligibleTabs.size).toBe(3)
})

it('searches remote indexes when local indexing is off without falling back for unavailable or unresolved owners', async () => {
  const initial = input(false)
  const props = {
    ...initial,
    workspaces: [
      ...initial.workspaces,
      makeWorktree('unresolved', 'Unknown', { hostId: 'runtime:unresolved-owner' })
    ]
  }
  searchSessions.mockImplementation(async (_request, scope) =>
    scope === 'runtime:remote' ? { kind: 'unavailable', reason: 'no-service' } : response(scope)
  )
  const { result } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps: props })
  await debounce()
  expect(searchSessions.mock.calls.map(([, scope]) => scope).sort()).toEqual([
    'runtime:folder-host',
    'runtime:remote'
  ])
  expect(result.current.transcriptMeasurement.candidates).toMatchObject([
    { tabId: 'native', executionHostId: 'runtime:folder-host' }
  ])
  await debounce()
  expect(searchSessions).toHaveBeenCalledTimes(2)
})

it('does not search a restored remote workspace with unproven or contradictory ownership', async () => {
  const props = input(false)
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
    initialProps: {
      ...props,
      workspaces: props.workspaces.map((workspace) =>
        workspace.id === 'remote-workspace'
          ? { ...workspace, hostId: 'runtime:unresolved-owner' as const }
          : workspace
      )
    }
  })
  await debounce()
  expect(searchSessions.mock.calls.map(([, scope]) => scope)).toEqual(['runtime:folder-host'])
  expect(
    result.current.transcriptMeasurement.candidates.map((candidate) => candidate.tabId)
  ).toEqual(['native'])
  rerender({
    ...props,
    workspaces: props.workspaces.map((workspace) =>
      workspace.id === 'remote-workspace'
        ? { ...workspace, runtimeOwnerEnvironmentId: 'different-owner' }
        : workspace
    )
  })
  await debounce()
  expect(searchSessions.mock.calls.map(([, scope]) => scope)).toEqual(['runtime:folder-host'])
})

it.each(['eligibleSessionsApplied', 'forksPreserved'] as const)(
  'downgrades an older host missing %s without discarding other hosts',
  async (capability) => {
    searchSessions.mockImplementation(async (_request, scope) => {
      const page = response(scope)
      if (page.kind === 'results' && scope === 'runtime:remote') {
        delete page[capability]
      }
      return page
    })
    const { result } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
      initialProps: input()
    })
    await debounce()
    expect(
      result.current.transcriptMeasurement.candidates.map((candidate) => candidate.tabId)
    ).toEqual(['terminal-0', 'native'])
  }
)

it('cancels outstanding remote results on raw query changes and closed destinations before deferred search catches up', async () => {
  let finish: (value: AiVaultSearchResponse) => void = () => {}
  searchSessions.mockImplementation(async (_request, scope) =>
    scope === 'runtime:remote'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : response(scope)
  )
  const props = input()
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
    initialProps: props
  })
  await debounce()
  rerender({ ...props, query: 'changed' })
  expect(result.current.transcriptMeasurement.candidates).toEqual([])
  await act(async () => finish(response('runtime:remote')))
  expect(result.current.transcriptMatches).toEqual([])
  await debounce()
  expect(searchSessions).toHaveBeenCalledTimes(3)
  rerender({ ...props, workspaces: props.workspaces.slice(0, 1) })
  await debounce()
  expect(
    result.current.transcriptMeasurement.candidates.map((candidate) => candidate.tabId)
  ).toEqual(['terminal-0'])
  expect(searchSessions.mock.calls.slice(3).map(([, scope]) => scope)).toEqual(['local'])
})

it('walks only the host that owes another page and replaces a stale remote cursor on its owning host', async () => {
  searchSessions.mockImplementation(async (request, scope) => {
    if (scope !== 'runtime:remote') {
      return response(scope)
    }
    if (request.cursor) {
      return { kind: 'stale-cursor', generation: 2 }
    }
    const page = response(scope)
    if (
      page.kind === 'results' &&
      searchSessions.mock.calls.filter(([, host]) => host === scope).length === 1
    ) {
      page.page = { cursor: 'remote-page-2', hasMore: true }
    }
    return page
  })
  const { result } = renderHook(useWorktreeJumpPaletteTranscriptMatches, { initialProps: input() })
  await debounce()
  act(() => result.current.transcriptMeasurement.onFits(new Map(), 'display'))
  await act(async () => {})
  expect(searchSessions.mock.calls.map(([, scope]) => scope)).toEqual([
    'local',
    'runtime:folder-host',
    'runtime:remote',
    'runtime:remote',
    'runtime:remote'
  ])
  expect(searchSessions.mock.calls[3][0].cursor).toBe('remote-page-2')
  expect(searchSessions.mock.calls[4][0].cursor).toBeUndefined()
  expect(result.current.transcriptMeasurement.candidates).toHaveLength(3)
})
