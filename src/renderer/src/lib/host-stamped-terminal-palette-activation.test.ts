// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  makeGroup,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from '@/components/worktree-jump-palette-test-fixtures'

// Why real activation: an earlier positive test mocked workspace activation and omitted the
// result host, so it could not see the palette handing activation the terminal's target host
// instead of the source workspace's. Only the store singleton and toast sink are substituted.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const { createTestStore } = await import('@/store/slices/store-test-helpers')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { activateWorkspaceTabPaletteResult } = await import('./workspace-tab-palette-activation')
const { buildSearchableWorkspaceTabs, searchWorkspaceTabs } =
  await import('./workspace-tab-palette-search')
const { getLocalSourceWorktreeIds } = await import('./terminal-worktree-route')
const { buildOpenTabSearchEntries, selectOpenTabSearchAgentState, selectOpenTabSearchEntryState } =
  await import('@/components/tab-bar/open-tab-search-entries')

const WT = 'repo-1::/src/project'
const TARGET = 'runtime:env-b'

const stamped: Tab = {
  ...makeUnifiedTab('host-tab', WT, 'host-tab', 'Host terminal'),
  executionHostId: TARGET,
  projectHostSetupId: 'setup-b'
}
const localTab: Tab = makeUnifiedTab('local-tab', WT, 'local-tab', 'Local shell')

function seed(worktrees: Worktree[], repoExecutionHostId?: ExecutionHostId): void {
  store.setState({
    repos: [
      {
        ...makeRepo(),
        path: '/src/project',
        displayName: 'project',
        connectionId: null,
        ...(repoExecutionHostId ? { executionHostId: repoExecutionHostId } : {})
      }
    ],
    worktreesByRepo: { 'repo-1': worktrees },
    groupsByWorktree: { [WT]: [makeGroup(WT, [stamped.id, localTab.id])] },
    activeGroupIdByWorktree: { [WT]: `group-${WT}` },
    unifiedTabsByWorktree: { [WT]: [stamped, localTab] },
    tabsByWorktree: {
      [WT]: [
        { ...makeTerminalTab('host-tab', WT, 'Host terminal'), ptyId: 'remote:env-b@@handle-1' },
        { ...makeTerminalTab('local-tab', WT, 'Local shell'), ptyId: 'pty-local-1', sortOrder: 1 }
      ]
    }
  })
}

/** The Cmd+J path: builder over every store worktree with state-derived proof, then search. */
function jumpPaletteResult(query: string) {
  const state = store.getState()
  const worktrees = Object.values(state.worktreesByRepo).flat()
  const entries = buildSearchableWorkspaceTabs({
    worktrees,
    ownershipWorktrees: worktrees,
    localSourceWorktreeIds: getLocalSourceWorktreeIds(state),
    repoMap: new Map(),
    worktreeOrder: new Map(),
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    openFiles: state.openFiles,
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    groupsByWorktree: state.groupsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    activeTabType: state.activeTabType,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    generatedTitlesEnabled: false
  })
  return searchWorkspaceTabs(entries, query)[0]
}

/** The tab-bar open-tab search path, through its real full-state selector. */
function openTabSearchResult(query: string) {
  const state = store.getState()
  const selected = selectOpenTabSearchEntryState(state, WT)
  const entries = selected
    ? buildOpenTabSearchEntries(selected, selectOpenTabSearchAgentState(state)).workspaceTabs
    : []
  return searchWorkspaceTabs(entries, query)[0]
}

function expectSourceActivation(sourceHost: string | null): void {
  const state = store.getState()
  expect(state.activeWorktreeId).toBe(WT)
  expect(state.activeWorkspaceExecutionHostId ?? null).toBe(sourceHost)
  expect(state.activeTabIdByWorktree[WT]).toBe('host-tab')
  // The tab still runs on its target; only the workspace selection is source-owned.
  const tab = state.unifiedTabsByWorktree[WT]?.find((candidate) => candidate.id === 'host-tab')
  expect(tab).toMatchObject({ executionHostId: TARGET, projectHostSetupId: 'setup-b' })
}

describe('activating a host-stamped terminal from a real palette result', () => {
  beforeEach(() => {
    store.setState(store.getInitialState(), true)
    // Why gh: setActiveWorktree's stale-PR refresh is a no-op without the IPC enqueue hook.
    vi.stubGlobal('window', { api: { gh: {} } })
  })

  it.each([
    ['the Cmd+J palette', jumpPaletteResult],
    ['the tab-bar open-tab search', openTabSearchResult]
  ])('activates the LOCAL source workspace from %s (explicit local host)', (_label, search) => {
    seed([makeWorktree(WT, 'project', { hostId: 'local' })])
    const result = search('Host terminal')

    expect(result?.tabId).toBe('host-tab')
    // Why the real result, host included: it must name the source, or the source lookup misses.
    expect(activateWorkspaceTabPaletteResult(result!)).toEqual({ status: 'activated' })
    expect(result?.executionHostId).toBe('local')
    expectSourceActivation('local')
  })

  it('activates a legacy source with no physical hostId once state proves it local', () => {
    seed([makeWorktree(WT, 'project')])
    const result = jumpPaletteResult('Host terminal')

    expect(result?.tabId).toBe('host-tab')
    expect(result?.executionHostId).not.toBe(TARGET)
    expect(activateWorkspaceTabPaletteResult(result!)).toEqual({ status: 'activated' })
    expectSourceActivation(result?.executionHostId ?? null)
  })

  const REFUSED_SOURCES: [string, Worktree[], ExecutionHostId | undefined][] = [
    [
      'a runtime-owned source',
      [makeWorktree(WT, 'project', { runtimeOwnerEnvironmentId: 'hub' })],
      undefined
    ],
    ['repo runtime provenance', [makeWorktree(WT, 'project')], 'runtime:hub'],
    [
      'an ambiguous same-id source on the target host',
      [
        makeWorktree(WT, 'project', { hostId: 'local' }),
        makeWorktree(WT, 'project', { hostId: TARGET })
      ],
      undefined
    ]
  ]

  it.each(REFUSED_SOURCES)(
    'never lists or activates the terminal for %s',
    (_label, worktrees, repoHost) => {
      seed(worktrees, repoHost)

      expect(jumpPaletteResult('Host terminal')?.tabId).not.toBe('host-tab')
      const forged = activateWorkspaceTabPaletteResult({
        worktreeId: WT,
        groupId: `group-${WT}`,
        tabId: 'host-tab',
        entityId: 'host-tab',
        contentType: 'terminal',
        executionHostId: TARGET
      })
      expect(forged.status).not.toBe('activated')
      expect(store.getState().unifiedTabsByWorktree[WT]?.[0]).toMatchObject({
        executionHostId: TARGET
      })
    }
  )

  it('keeps an ordinary local terminal on its source host', () => {
    seed([makeWorktree(WT, 'project', { hostId: 'local' })])
    const result = jumpPaletteResult('Local shell')

    expect(result?.tabId).toBe('local-tab')
    expect(result?.executionHostId).toBe('local')
    expect(activateWorkspaceTabPaletteResult(result!)).toEqual({ status: 'activated' })
    expect(store.getState().activeTabIdByWorktree[WT]).toBe('local-tab')
  })
})
