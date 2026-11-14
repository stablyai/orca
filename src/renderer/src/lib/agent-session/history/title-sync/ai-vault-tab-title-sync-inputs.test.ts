import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import * as worktreeCatalog from '@/store/slices/worktrees/listing/worktree-catalog-index'
import * as repoCatalog from '@/store/repos/repository-catalog-index'
import * as worktreeOwner from '@/lib/workspace/ownership/worktree-runtime-owner'
import * as titleAgents from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import * as stablePaneIds from '../../../../../../shared/workspace-layout/stable-pane-id'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { aiVaultTitleSyncInputsChanged } from './ai-vault-tab-title-sync-inputs'
import { collectAgentPaneConversations } from '../../identity/pane-agent-conversations'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'

afterEach(() => vi.restoreAllMocks())

function makeState(count = 1): AppState {
  const live: AppState['agentStatusByPaneKey'] = {}
  const sleeping: AppState['sleepingAgentSessionsByPaneKey'] = {}
  const tabs: TerminalTab[] = []
  for (let index = 0; index < count * 2; index++) {
    const tab: TerminalTab = {
      id: `tab-${index}`,
      worktreeId: 'wt-title',
      ptyId: null,
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: 1
    }
    const entry = {
      paneKey: `${tab.id}:00000000-0000-4000-8000-000000000001`,
      tabId: tab.id,
      worktreeId: tab.worktreeId,
      agentType: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: `session-${index}` },
      state: 'done' as const,
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: []
    }
    tabs.push(tab)
    if (index < count) {
      live[entry.paneKey] = entry
    } else {
      sleeping[entry.paneKey] = {
        ...entry,
        agent: 'codex',
        capturedAt: 1,
        origin: 'worktree-sleep'
      }
    }
  }
  return {
    agentStatusByPaneKey: live,
    sleepingAgentSessionsByPaneKey: sleeping,
    tabsByWorktree: { 'wt-title': tabs },
    terminalLayoutsByTabId: {},
    activeWorktreeId: 'wt-title',
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: { fixture: [{ id: 'wt-title', repoId: 'fixture', hostId: 'local' }] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    repos: [],
    settings: {}
  } as unknown as AppState
}

async function collectGarbage(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('AI Vault title subscription inputs', () => {
  it.each([100, 1000])('compares only addressed title facts among %i associations', (count) => {
    const state = makeState(count)
    state.agentStatusByPaneKey = {}
    state.sleepingAgentSessionsByPaneKey = {}
    const key = 'tab-0:00000000-0000-4000-8000-000000000001'
    state.agentConversationsByPaneKey = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const paneKey = `tab-${index}:00000000-0000-4000-8000-000000000001`
        return [
          paneKey,
          {
            paneKey,
            worktreeId: 'wt-title',
            executionHostId: 'local' as const,
            connectionId: null,
            agent: 'codex' as const,
            ...(index === 0
              ? { providerSession: { key: 'session_id' as const, id: 'wanted' } }
              : {})
          }
        ]
      })
    )
    const classify = vi.spyOn(titleAgents, 'isAiVaultTitleAgent')
    const lookups = [
      vi.spyOn(worktreeCatalog, 'getIndexedWorktreeMap'),
      vi.spyOn(repoCatalog, 'getIndexedRepoMap'),
      vi.spyOn(worktreeOwner, 'getExecutionHostIdForWorktree')
    ]
    for (const changedKey of [key, 'tab-1:00000000-0000-4000-8000-000000000001']) {
      const equivalent = {
        ...state,
        agentConversationsByPaneKey: replaceRecordEntries<
          AppState['agentConversationsByPaneKey'][string]
        >(state.agentConversationsByPaneKey, [
          [
            changedKey,
            { ...state.agentConversationsByPaneKey[changedKey]!, firstStateStartedAt: 2000 }
          ]
        ])
      }
      classify.mockClear()
      expect(aiVaultTitleSyncInputsChanged(equivalent, state)).toBe(false)
      expect(classify.mock.calls.length).toBeLessThanOrEqual(2)
    }
    const changed = {
      ...state,
      agentConversationsByPaneKey: replaceRecordEntries<
        AppState['agentConversationsByPaneKey'][string]
      >(state.agentConversationsByPaneKey, [
        [
          key,
          {
            ...state.agentConversationsByPaneKey[key]!,
            providerSession: { key: 'session_id' as const, id: 'new' }
          }
        ]
      ])
    }
    classify.mockClear()
    expect(aiVaultTitleSyncInputsChanged(changed, state)).toBe(true)
    expect(classify.mock.calls.length).toBeLessThanOrEqual(2)
    for (const lookup of lookups) {
      expect(lookup.mock.calls.length).toBe(0)
    }

    const visits: string[] = []
    const a = '00000000-0000-4000-8000-000000000001'
    const c = '00000000-0000-4000-8000-000000000003'
    const leaf = (tab: string, leafId: string) => ({
      get type() {
        visits.push(tab)
        return 'leaf' as const
      },
      leafId
    })
    state.terminalLayoutsByTabId = Object.fromEntries(
      state.tabsByWorktree['wt-title'].map((tab) => [
        tab.id,
        {
          root: leaf(tab.id, a),
          activeLeafId: a,
          expandedLeafId: null
        }
      ])
    )
    state.terminalLayoutsByTabId['tab-0'] = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: leaf('tab-0', a),
        second: leaf('tab-0', c)
      },
      activeLeafId: c,
      expandedLeafId: null
    }
    const metadataOnly = {
      ...state,
      terminalLayoutsByTabId: replaceRecordEntries<AppState['terminalLayoutsByTabId'][string]>(
        state.terminalLayoutsByTabId,
        [
          [
            'tab-0',
            { ...state.terminalLayoutsByTabId['tab-0']!, ptyIdsByLeafId: { [c]: 'pty-new' } }
          ]
        ]
      )
    }
    classify.mockClear()
    expect(aiVaultTitleSyncInputsChanged(metadataOnly, state)).toBe(false)
    expect(visits).toEqual([])
    expect(classify.mock.calls.length).toBe(0)
    const pruned = {
      ...state,
      terminalLayoutsByTabId: replaceRecordEntries<AppState['terminalLayoutsByTabId'][string]>(
        state.terminalLayoutsByTabId,
        [['tab-0', { ...state.terminalLayoutsByTabId['tab-0']!, root: leaf('tab-0', c) }]]
      )
    }
    expect(aiVaultTitleSyncInputsChanged(pruned, state)).toBe(true)
    expect(visits.every((tab) => tab === 'tab-0')).toBe(true)
    expect(visits.length).toBeLessThanOrEqual(4)
    expect(classify.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it.each([100, 1000])('compares %i restored rootless layouts in one source pass', (count) => {
    const state = makeState(count)
    state.agentStatusByPaneKey = {}
    state.sleepingAgentSessionsByPaneKey = {}
    const a = '00000000-0000-4000-8000-000000000001'
    const b = '00000000-0000-4000-8000-000000000002'
    state.agentConversationsByPaneKey = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const paneKey = `tab-${index}:${a}`
        return [
          paneKey,
          {
            paneKey,
            worktreeId: 'wt-title',
            executionHostId: 'local' as const,
            connectionId: null,
            agent: 'codex' as const,
            providerSession: { key: 'session_id' as const, id: `session-${index}` }
          }
        ]
      })
    )
    state.terminalLayoutsByTabId = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `tab-${index}`,
        { root: null, activeLeafId: a, expandedLeafId: null }
      ])
    )
    const rooted = {
      ...state,
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `tab-${index}`,
          {
            root: { type: 'leaf' as const, leafId: a },
            activeLeafId: a,
            expandedLeafId: null
          }
        ])
      )
    }
    const classify = vi.spyOn(titleAgents, 'isAiVaultTitleAgent')
    const parse = vi.spyOn(stablePaneIds, 'parsePaneKey')
    expect(aiVaultTitleSyncInputsChanged(rooted, state)).toBe(false)
    expect(classify.mock.calls.length).toBeLessThanOrEqual(2 * count)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(2 * count)
    const excluded = {
      ...rooted,
      terminalLayoutsByTabId: {
        ...rooted.terminalLayoutsByTabId,
        'tab-0': {
          root: { type: 'leaf' as const, leafId: b },
          activeLeafId: a,
          expandedLeafId: null
        }
      }
    }
    expect(aiVaultTitleSyncInputsChanged(excluded, state)).toBe(true)
  })

  it.each([100, 1000])('does no ownership lookups for %i unusable title identities', (count) => {
    const state = makeState(count)
    state.agentStatusByPaneKey = {}
    state.sleepingAgentSessionsByPaneKey = {}
    for (const tab of state.tabsByWorktree['wt-title']) {
      state.terminalLayoutsByTabId[tab.id] = {
        root: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000001' },
        activeLeafId: '00000000-0000-4000-8000-000000000001',
        expandedLeafId: null
      }
    }
    const identities: AppState['agentConversationsByPaneKey'] = {}
    for (let index = 1; index <= count; index++) {
      const paneKey = `tab-${index}:00000000-0000-4000-8000-000000000001`
      identities[paneKey] = {
        paneKey,
        worktreeId: 'wt-title',
        executionHostId: 'local',
        connectionId: null,
        agent: index % 3 === 2 ? 'pi' : 'codex',
        ...(index % 3 === 0
          ? {}
          : { providerSession: { key: 'session_id', id: index % 3 === 1 ? '' : 'pi-session' } })
      }
    }
    state.agentConversationsByPaneKey = identities
    const lookups = [
      vi.spyOn(worktreeCatalog, 'getIndexedWorktreeMap'),
      vi.spyOn(repoCatalog, 'getIndexedRepoMap'),
      vi.spyOn(worktreeOwner, 'getExecutionHostIdForWorktree')
    ]
    expect(collectAiVaultTitleRequests(state)).toEqual([])
    for (const lookup of lookups) {
      expect(lookup.mock.calls.length).toBe(0)
    }

    const paneKey = 'tab-0:00000000-0000-4000-8000-000000000001'
    const qualified = {
      paneKey,
      worktreeId: 'wt-title',
      executionHostId: 'local' as const,
      connectionId: null,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'wanted-session' }
    }
    const expected = [
      {
        agent: 'codex',
        executionHostId: 'local',
        providerSession: { key: 'session_id', id: 'wanted-session' },
        refresh: false,
        tabId: 'tab-0',
        paneKey,
        worktreeId: 'wt-title'
      }
    ]
    state.agentConversationsByPaneKey = { [paneKey]: qualified }
    for (const lookup of lookups) {
      lookup.mockClear()
    }
    expect(collectAiVaultTitleRequests(state)).toEqual(expected)
    const fixedLookupCounts = lookups.map((lookup) => lookup.mock.calls.length)
    state.agentConversationsByPaneKey = { ...identities, [paneKey]: qualified }
    for (const lookup of lookups) {
      lookup.mockClear()
    }
    expect(collectAiVaultTitleRequests(state)).toEqual(expected)
    expect(
      lookups.map((lookup, index) => lookup.mock.calls.length - fixedLookupCounts[index])
    ).toEqual([0, 0, 0])

    state.agentConversationsByPaneKey = { [paneKey]: { ...qualified, agent: 'pi' } }
    expect(collectAgentPaneConversations(state, (agent): agent is 'pi' => agent === 'pi')).toEqual([
      { ...expected[0], agent: 'pi' }
    ])
  })

  it('ignores rank and settings changes but reports a conversation workspace moving host', () => {
    // No active selection, so the row's host decides ownership.
    const state = {
      ...makeState(200),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null
    }
    const row = state.worktreesByRepo.fixture[0]
    // A rank/unread patch replaces the row map without changing who owns any row.
    const ranked: AppState = {
      ...state,
      worktreesByRepo: { fixture: [{ ...row, sortOrder: 5, isUnread: true }] }
    }
    expect(aiVaultTitleSyncInputsChanged(ranked, state)).toBe(false)

    const settingsOnly: AppState = { ...ranked, settings: structuredClone(ranked.settings) }
    expect(aiVaultTitleSyncInputsChanged(settingsOnly, ranked)).toBe(false)
    expect(aiVaultTitleSyncInputsChanged({ ...settingsOnly }, settingsOnly)).toBe(false)

    const moved: AppState = {
      ...settingsOnly,
      worktreesByRepo: {
        fixture: [{ ...row, hostId: 'runtime:server-1', runtimeOwnerEnvironmentId: 'server-1' }]
      }
    }
    expect(aiVaultTitleSyncInputsChanged(moved, settingsOnly)).toBe(true)
  })

  it("releases a closed tab's status and tab maps after an update that skips the owner comparison", async () => {
    function cacheThenCloseTab() {
      const open = makeState(3)
      // An owner-only update caches request membership for the open tabs.
      const ownerOnly: AppState = { ...open, settings: structuredClone(open.settings) }
      expect(aiVaultTitleSyncInputsChanged(ownerOnly, open)).toBe(false)
      // Closing a tab replaces membership maps and returns before any owner comparison.
      const [closedPane] = Object.keys(open.agentStatusByPaneKey)
      const { [closedPane]: _closed, ...agentStatusByPaneKey } = open.agentStatusByPaneKey
      const closed: AppState = {
        ...ownerOnly,
        agentStatusByPaneKey,
        tabsByWorktree: { 'wt-title': open.tabsByWorktree['wt-title'].slice(1) }
      }
      expect(aiVaultTitleSyncInputsChanged(closed, ownerOnly)).toBe(true)
      return {
        closed,
        retired: [new WeakRef(open.agentStatusByPaneKey), new WeakRef(open.tabsByWorktree)]
      }
    }

    const { closed, retired } = cacheThenCloseTab()
    await collectGarbage()

    expect(retired.map((ref) => ref.deref())).toEqual([undefined, undefined])
    expect(
      aiVaultTitleSyncInputsChanged(
        { ...closed, settings: structuredClone(closed.settings) },
        closed
      )
    ).toBe(false)
  })
})
