import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../shared/ai-vault-session-title'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { workspaceSessionStateSchema } from '../../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  applyLocalStructuredSessionTabSnapshots,
  LOCAL_STRUCTURED_SESSION_OWNER
} from '../runtime/local-structured-session-tabs-sync'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../runtime/web-session-tabs-sync'
import { patchTab } from '../store/slices/tab-group-state'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import { applyAgentSessionAiVaultTitle } from '../store/slices/agent-session-tab-ai-vault-title'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { startAiVaultTabTitleSync } from './ai-vault-tab-title-sync'
import type { AppState } from '@/store/types'

const WORKTREE_ID = 'repo-1::worktree-1'
const GROUP_ID = 'group-1'

afterEach(() => {
  resetWebSessionTabsSnapshotFreshnessForTests()
})

type SessionSpec = { sessionId: string; providerSessionId?: string; title?: string }

function hostSnapshot(
  epoch: string,
  snapshotVersion: number,
  sessions: readonly SessionSpec[]
): RuntimeMobileSessionTabsResult {
  const tabIds = sessions.map((session) => `agent-session:${session.sessionId}`)
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: epoch,
    snapshotVersion,
    activeGroupId: GROUP_ID,
    activeTabId: tabIds[0] ?? null,
    activeTabType: 'agent-session',
    tabGroups: [{ id: GROUP_ID, activeTabId: tabIds[0] ?? null, tabOrder: tabIds }],
    tabs: sessions.map((session, index) => ({
      type: 'agent-session' as const,
      id: tabIds[index]!,
      title: session.title ?? 'Codex Chat',
      sessionId: session.sessionId,
      agent: 'codex' as const,
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      isActive: index === 0
    }))
  }
}

function emptyState(): AppState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: null,
    activeTabTypeByWorktree: {},
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () => ({ path: '/workspace/repo-1' }),
    groupsByWorktree: { [WORKTREE_ID]: [] },
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    repos: [],
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    sortEpoch: 0,
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    worktreesByRepo: {}
  } as unknown as AppState
}

let epochCounter = 0

function makeStore() {
  const epoch = `epoch-${(epochCounter += 1)}`
  const listeners = new Set<(next: AppState, previous: AppState) => void>()
  const labelHistory: string[] = []
  let state = emptyState()
  const commit = (next: AppState): void => {
    if (next === state) {
      return
    }
    const previous = state
    state = next
    const tab = chatTabs(state)[0]
    if (tab) {
      labelHistory.push(resolveUnifiedTabLabel(tab, false, 'Codex Chat'))
    }
    for (const listener of listeners) {
      listener(state, previous)
    }
  }
  // Why: the real store action, so a test cannot pass on a hand-written title write.
  state = {
    ...state,
    setAiVaultTabTitle: (tabId: string, aiVaultTitle: Tab['aiVaultTitle'] | null) => {
      const patched = applyAgentSessionAiVaultTitle(
        state.unifiedTabsByWorktree,
        tabId,
        aiVaultTitle ?? null
      )
      if (patched) {
        commit({ ...state, unifiedTabsByWorktree: patched })
      }
    }
  } as AppState
  return {
    getState: () => state,
    labelHistory,
    subscribe: (listener: (next: AppState, previous: AppState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (snapshotVersion: number, sessions: readonly SessionSpec[]) => {
      commit(
        applyLocalStructuredSessionTabSnapshots(
          state,
          [hostSnapshot(epoch, snapshotVersion, sessions)],
          LOCAL_STRUCTURED_SESSION_OWNER
        ) as AppState
      )
    },
    rename: (tabId: string, label: string) => {
      const patched = patchTab(state.unifiedTabsByWorktree, tabId, { customLabel: label })
      if (patched) {
        commit({ ...state, ...patched } as AppState)
      }
    }
  }
}

/** Lets the sync's queued reconcile run to completion before the next host publish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function chatTabs(state: AppState): Tab[] {
  return (state.unifiedTabsByWorktree[WORKTREE_ID] ?? []).filter(
    (tab) => tab.contentType === 'agent-session'
  )
}

function labelOf(state: AppState, sessionId: string): string {
  const tab = chatTabs(state).find((candidate) => candidate.entityId === sessionId)
  return tab ? resolveUnifiedTabLabel(tab, false, 'Codex Chat') : 'missing'
}

function titleResolver(
  titleByProviderSessionId: Record<string, string>
): (args: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult> {
  return async (args) => ({
    titles: args.requests.flatMap((request) => {
      const title = titleByProviderSessionId[request.sessionId]
      return title ? [{ agent: request.agent, sessionId: request.sessionId, title }] : []
    })
  })
}

describe('structured Codex chat tab titles', () => {
  it('adopts the provider session title when the chat tab is created', async () => {
    const store = makeStore()
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })
    // Created after the sync is already running, as a real launch is.
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])

    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser'))
    stop()
  })

  it('names the chat once the host proves the thread it was launched without', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1' }])
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })
    await settle()
    expect(labelOf(store.getState(), 'codex-1')).toBe('Codex Chat')

    store.publish(2, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])

    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser'))
    stop()
  })

  it('degrades to the generic label when an older host omits provider identity', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })
    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser'))
    stop()

    store.publish(2, [{ sessionId: 'codex-1' }])

    const tab = chatTabs(store.getState())[0]!
    expect(tab.agentSessionProviderSessionId).toBeUndefined()
    expect(tab.aiVaultTitle).toBeUndefined()
    expect(labelOf(store.getState(), 'codex-1')).toBe('Codex Chat')
  })

  it('does not carry one provider conversation title across a thread replacement', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })
    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser'))
    stop()

    store.publish(2, [{ sessionId: 'codex-1', providerSessionId: 'thread-2' }])

    const tab = chatTabs(store.getState())[0]!
    expect(tab.agentSessionProviderSessionId).toBe('thread-2')
    expect(tab.aiVaultTitle).toBeUndefined()
    expect(labelOf(store.getState(), 'codex-1')).toBe('Codex Chat')
  })

  it('picks up a later provider title without ever falling back to the generic label', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    let title = 'Rewrite the parser'
    let refresh: (() => void) | null = null
    const delays: number[] = []
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: async () => ({
        titles: [{ agent: 'codex', sessionId: 'thread-1', title }]
      }),
      setTimer: (callback, delay) => {
        refresh = callback
        delays.push(delay)
        return 0
      },
      clearTimer: () => {}
    })
    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe(title))

    // The live-session refresh is what carries a renamed thread to the tab.
    title = 'Ship the parser fix'
    await vi.waitFor(() => expect(refresh).not.toBeNull())
    refresh!()
    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe(title))

    // A host republish carries no name of its own; the tab must not blink back to the generic one.
    store.publish(2, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    await settle()
    expect(labelOf(store.getState(), 'codex-1')).toBe(title)
    expect(store.labelHistory.slice(1)).not.toContain('Codex Chat')
    // A named chat is on the settled cadence, not the every-20s hunt for a missing name.
    expect(delays).toEqual([300_000, 300_000])
    stop()
  })

  it('keeps a manual rename ahead of a later provider title', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    const tabId = chatTabs(store.getState())[0]!.id
    store.rename(tabId, 'Parser work')
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })

    await vi.waitFor(() =>
      expect(chatTabs(store.getState())[0]!.aiVaultTitle?.title).toBe('Rewrite the parser')
    )
    store.publish(2, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])

    expect(labelOf(store.getState(), 'codex-1')).toBe('Parser work')
    expect(store.labelHistory).not.toContain('Rewrite the parser')
    stop()
  })

  it('restores the provider title and its session identity across a restart', async () => {
    const store = makeStore()
    store.publish(1, [{ sessionId: 'codex-1', providerSessionId: 'thread-1' }])
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-1': 'Rewrite the parser' })
    })
    await vi.waitFor(() => expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser'))
    stop()

    const persisted = buildPersistedUnifiedTabSessionData({
      activeGroupIdByWorktree: store.getState().activeGroupIdByWorktree,
      groupsByWorktree: store.getState().groupsByWorktree,
      layoutByWorktree: store.getState().layoutByWorktree,
      unifiedTabsByWorktree: store.getState().unifiedTabsByWorktree
    })
    const reloaded: WorkspaceSessionState = workspaceSessionStateSchema.parse({
      ...persisted,
      activeRepoId: 'repo-1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: null,
      terminalLayoutsByTabId: {},
      tabsByWorktree: {}
    })
    const hydrated = buildHydratedTabState(reloaded, new Set([WORKTREE_ID]))
    const restored = hydrated.unifiedTabsByWorktree[WORKTREE_ID]!.find(
      (tab) => tab.contentType === 'agent-session'
    )!

    expect(resolveUnifiedTabLabel(restored, false, 'Codex Chat')).toBe('Rewrite the parser')
    expect(restored.agentSessionProviderSessionId).toBe('thread-1')
  })

  it('never lets one Codex session name another chat tab', async () => {
    const store = makeStore()
    store.publish(1, [
      { sessionId: 'codex-1', providerSessionId: 'thread-1' },
      { sessionId: 'codex-2', providerSessionId: 'thread-2' }
    ])
    const stop = startAiVaultTabTitleSync({
      getState: store.getState,
      subscribe: store.subscribe,
      resolveSessionTitles: titleResolver({
        'thread-1': 'Rewrite the parser',
        'thread-2': 'Fix the flaky suite'
      })
    })

    await vi.waitFor(() => {
      expect(labelOf(store.getState(), 'codex-1')).toBe('Rewrite the parser')
      expect(labelOf(store.getState(), 'codex-2')).toBe('Fix the flaky suite')
    })
    stop()

    // An answer for one thread must not name the other; unknown stays unknown.
    const partial = makeStore()
    partial.publish(1, [
      { sessionId: 'codex-3', providerSessionId: 'thread-3' },
      { sessionId: 'codex-4', providerSessionId: 'thread-4' }
    ])
    const stopPartial = startAiVaultTabTitleSync({
      getState: partial.getState,
      subscribe: partial.subscribe,
      resolveSessionTitles: titleResolver({ 'thread-4': 'Fix the flaky suite' })
    })
    await vi.waitFor(() =>
      expect(labelOf(partial.getState(), 'codex-4')).toBe('Fix the flaky suite')
    )
    expect(labelOf(partial.getState(), 'codex-3')).toBe('Codex Chat')
    stopPartial()
  })
})
