import { createStore } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { aiVaultTitleSyncInputsChanged } from './ai-vault-tab-title-sync-inputs'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'

const COLLECTIONS = [
  'agentStatusByPaneKey',
  'retainedAgentsByPaneKey',
  'sleepingAgentSessionsByPaneKey'
] as const
type Collection = (typeof COLLECTIONS)[number]

function makeState(count = 1): AppState {
  const live: AppState['agentStatusByPaneKey'] = {}
  const retained: AppState['retainedAgentsByPaneKey'] = {}
  const sleeping: AppState['sleepingAgentSessionsByPaneKey'] = {}
  const tabs: TerminalTab[] = []
  for (let index = 0; index < count * 3; index++) {
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
    } else if (index < count * 2) {
      retained[entry.paneKey] = {
        entry,
        tab,
        worktreeId: tab.worktreeId,
        agentType: 'codex',
        startedAt: 1
      }
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
    retainedAgentsByPaneKey: retained,
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

function replaceProvider(
  state: AppState,
  collection: Collection,
  providerSession: AgentProviderSessionMetadata
): AppState {
  const paneKey = Object.keys(state[collection])[0]
  const existing = state[collection][paneKey]
  const next =
    collection === 'retainedAgentsByPaneKey'
      ? { ...existing, entry: { ...state.retainedAgentsByPaneKey[paneKey].entry, providerSession } }
      : { ...existing, providerSession }
  return { ...state, [collection]: { ...state[collection], [paneKey]: next } }
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
  it('does not enumerate unchanged retained and sleeping maps during live status writes', () => {
    const state = makeState(500)
    let unchangedEnumerations = 0
    const observeEnumerations = <T extends object>(records: T): T =>
      new Proxy(records, {
        ownKeys(target) {
          unchangedEnumerations++
          return Reflect.ownKeys(target)
        }
      })
    state.retainedAgentsByPaneKey = observeEnumerations(state.retainedAgentsByPaneKey)
    state.sleepingAgentSessionsByPaneKey = observeEnumerations(state.sleepingAgentSessionsByPaneKey)
    const store = createStore<AppState>(() => state)
    const scheduleReconcile = vi.fn(() => () => {})
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      scheduleReconcile,
      resolveSessionTitles: vi.fn()
    })
    try {
      const paneKey = Object.keys(state.agentStatusByPaneKey)[0]
      for (let index = 0; index < 50; index++) {
        store.setState((current) => ({
          agentStatusByPaneKey: {
            ...current.agentStatusByPaneKey,
            [paneKey]: { ...current.agentStatusByPaneKey[paneKey], updatedAt: index + 2 }
          }
        }))
      }
      expect(unchangedEnumerations).toBe(0)
      expect(scheduleReconcile).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it.each(COLLECTIONS)(
    'still detects provider changes in %s with other maps reused',
    (collection) => {
      const state = makeState()
      const paneKey = Object.keys(state[collection])[0]
      const provider =
        collection === 'retainedAgentsByPaneKey'
          ? state.retainedAgentsByPaneKey[paneKey].entry.providerSession!
          : (state[collection][paneKey] as { providerSession: AgentProviderSessionMetadata })
              .providerSession
      for (const patch of [
        { id: 'changed' },
        { key: 'conversation_id' as const },
        { transcriptPath: '/changed/session' }
      ]) {
        expect(
          aiVaultTitleSyncInputsChanged(
            replaceProvider(state, collection, { ...provider, ...patch }),
            state
          )
        ).toBe(true)
      }
      expect(
        aiVaultTitleSyncInputsChanged(replaceProvider(state, collection, { ...provider }), state)
      ).toBe(false)
    }
  )

  it.each(COLLECTIONS)('detects additions and removals in %s', (collection) => {
    const state = makeState()
    const records = state[collection]
    const empty = { ...state, [collection]: {} }
    expect(aiVaultTitleSyncInputsChanged(empty, state)).toBe(true)
    expect(aiVaultTitleSyncInputsChanged(state, empty)).toBe(true)
    expect(aiVaultTitleSyncInputsChanged({ ...state, [collection]: { ...records } }, state)).toBe(
      false
    )
  })

  it.each(COLLECTIONS)('detects agent and pane ownership changes in %s', (collection) => {
    const state = makeState()
    const records = state[collection]
    const paneKey = Object.keys(records)[0]
    const record = records[paneKey]
    const entry =
      collection === 'retainedAgentsByPaneKey'
        ? state.retainedAgentsByPaneKey[paneKey].entry
        : record
    const agentField = collection === 'sleepingAgentSessionsByPaneKey' ? 'agent' : 'agentType'
    const changedRecords = [
      { ...record, [agentField]: 'claude' },
      { ...record, [agentField]: 'gemini' },
      { ...record, worktreeId: 'other' },
      ...['paneKey', 'tabId'].map((field) =>
        collection === 'retainedAgentsByPaneKey'
          ? { ...record, entry: { ...entry, [field]: 'other' } }
          : { ...record, [field]: 'other' }
      )
    ]
    for (const changed of changedRecords) {
      expect(
        aiVaultTitleSyncInputsChanged(
          { ...state, [collection]: { ...records, [paneKey]: changed } },
          state
        )
      ).toBe(true)
    }
  })

  it('still checks workspace ownership after unchanged record collections', () => {
    const state = makeState()
    for (const host of ['ssh:host-1', 'runtime:server-1'] as const) {
      expect(
        aiVaultTitleSyncInputsChanged(
          {
            ...state,
            agentStatusByPaneKey: { ...state.agentStatusByPaneKey },
            activeWorkspaceExecutionHostId: host
          },
          state
        )
      ).toBe(true)
    }
  })

  it('skips owner rescans for rank-only rows but reports a conversation workspace moving host', () => {
    // No active selection, so the row's host decides ownership.
    const state = {
      ...makeState(200),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null
    }
    const row = state.worktreesByRepo.fixture[0]
    const tabs = Object.values(state.tabsByWorktree).flat()
    const tabValues = vi.spyOn(state.tabsByWorktree, 'wt-title', 'get').mockReturnValue(tabs)
    // A rank/unread patch replaces the row map without changing who owns any row.
    const ranked: AppState = {
      ...state,
      worktreesByRepo: { fixture: [{ ...row, sortOrder: 5, isUnread: true }] }
    }
    expect(aiVaultTitleSyncInputsChanged(ranked, state)).toBe(false)
    expect(tabValues).not.toHaveBeenCalled()

    const settingsOnly: AppState = { ...ranked, settings: structuredClone(ranked.settings) }
    expect(aiVaultTitleSyncInputsChanged(settingsOnly, ranked)).toBe(false)
    expect(aiVaultTitleSyncInputsChanged({ ...settingsOnly }, settingsOnly)).toBe(false)
    // Membership was collected once and reused across owner-only updates.
    expect(tabValues.mock.calls.length).toBeLessThanOrEqual(1)

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

  it('still checks active panes and stored titles after unchanged record collections', () => {
    const state = makeState()
    const agentStatusByPaneKey = { ...state.agentStatusByPaneKey }
    expect(
      aiVaultTitleSyncInputsChanged(
        {
          ...state,
          agentStatusByPaneKey,
          terminalLayoutsByTabId: {
            'tab-0': { root: null, activeLeafId: 'other', expandedLeafId: null }
          }
        },
        state
      )
    ).toBe(true)
    const tabs = state.tabsByWorktree['wt-title']
    expect(
      aiVaultTitleSyncInputsChanged(
        {
          ...state,
          agentStatusByPaneKey,
          tabsByWorktree: {
            'wt-title': [
              {
                ...tabs[0],
                aiVaultTitle: { agent: 'codex', sessionId: 'session-0', title: 'New title' }
              },
              ...tabs.slice(1)
            ]
          }
        },
        state
      )
    ).toBe(true)
  })
})
