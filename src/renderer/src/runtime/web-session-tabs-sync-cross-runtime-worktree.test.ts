import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import type { MirrorRowOwnershipState } from './web-session-tabs-sync/mirror-row-ownership'
import {
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

// #31983: desktop B mirrors one SSH workspace from two paired runtimes — the host's server, which
// runs its terminals, and desktop A's app, which hosts a browser tab A opened there.
const SERVER_ENV = 'server-env'
const DESKTOP_A_ENV = 'desktop-a-env'

function apply(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number
): WebSessionTabsSyncState {
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environmentId, now) }
}

function serverTerminal(
  hostTabId: string,
  ready: boolean
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return ready
    ? {
        type: 'terminal',
        id: `${hostTabId}::${LEAF_ID}`,
        title: 'claude',
        parentTabId: hostTabId,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: `pty-${hostTabId}`
      }
    : {
        type: 'terminal',
        id: `${hostTabId}::${LEAF_ID}`,
        title: 'claude',
        parentTabId: hostTabId,
        leafId: LEAF_ID,
        isActive: true,
        status: 'pending-handle',
        terminal: null
      }
}

function desktopABrowserSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  version: number
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(tabs, {
    publicationEpoch: 'desktop-a-epoch',
    snapshotVersion: version,
    activeGroupId: `headless-terminals:${WT}`,
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'browser'
  })
}

const desktopAPage: RuntimeMobileSessionTabsResult['tabs'][number] = {
  type: 'browser',
  id: 'a-browser-tab',
  title: 'Example Domain',
  browserWorkspaceId: 'a-browser-workspace',
  browserPageId: 'a-browser-page',
  url: 'https://example.com/',
  loading: true,
  canGoBack: false,
  canGoForward: false,
  placement: {
    kind: 'client',
    browserHostClientId: 'desktop-a',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  },
  isActive: true
}

function terminalIds(state: WebSessionTabsSyncState): string[] {
  return (state.tabsByWorktree[WT] ?? []).map((tab) => tab.id).sort()
}

function unifiedTerminalIds(state: WebSessionTabsSyncState): string[] {
  return (state.unifiedTabsByWorktree[WT] ?? [])
    .filter((tab) => tab.contentType === 'terminal')
    .map((tab) => tab.entityId)
    .sort()
}

function groupedTabIds(state: WebSessionTabsSyncState): Set<string> {
  return new Set((state.groupsByWorktree[WT] ?? []).flatMap((group) => group.tabOrder))
}

describe('a workspace mirrored from two paired runtimes', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it.each([
    ['ready', true],
    ['still waiting for a stream handle', false]
  ])(
    "keeps the server's %s terminals when the other runtime opens and closes a browser tab",
    (_label, ready) => {
      let state = apply(
        makeState(),
        makeSnapshot([serverTerminal('agent-1', ready), serverTerminal('agent-2', ready)]),
        SERVER_ENV,
        NOW
      )
      const before = terminalIds(state)
      expect(before).toHaveLength(2)
      const createdAt = new Map(
        (state.tabsByWorktree[WT] ?? []).map((tab) => [tab.id, tab.createdAt])
      )

      state = apply(state, desktopABrowserSnapshot([desktopAPage], 1), DESKTOP_A_ENV, NOW + 1000)
      expect(terminalIds(state)).toEqual(before)
      expect(unifiedTerminalIds(state)).toEqual(before)
      expect(state.browserTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['a-browser-workspace'])

      state = apply(state, desktopABrowserSnapshot([], 2), DESKTOP_A_ENV, NOW + 2000)
      expect(terminalIds(state)).toEqual(before)
      expect(unifiedTerminalIds(state)).toEqual(before)
      const grouped = groupedTabIds(state)
      for (const tab of state.unifiedTabsByWorktree[WT] ?? []) {
        expect(grouped.has(tab.id)).toBe(true)
      }

      // The server's next frame rebuilds its rows in place rather than re-creating dropped ones.
      state = apply(
        state,
        makeSnapshot([serverTerminal('agent-1', ready), serverTerminal('agent-2', ready)], {
          snapshotVersion: 2
        }),
        SERVER_ENV,
        NOW + 3000
      )
      for (const tab of state.tabsByWorktree[WT] ?? []) {
        expect(tab.createdAt).toBe(createdAt.get(tab.id))
      }
    }
  )

  it("keeps the server's terminals when the other runtime retracts the workspace", () => {
    let state = apply(makeState(), makeSnapshot([serverTerminal('agent-1', true)]), SERVER_ENV, NOW)
    state = apply(state, desktopABrowserSnapshot([desktopAPage], 1), DESKTOP_A_ENV, NOW + 1000)
    const retraction: RuntimeMobileSessionTabsRemovedResult = {
      ...desktopABrowserSnapshot([], 2),
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    state = apply(state, retraction, DESKTOP_A_ENV, NOW + 2000)
    expect(terminalIds(state)).toEqual(['web-terminal-agent-1'])
    expect(state.browserTabsByWorktree[WT] ?? []).toEqual([])
  })

  it("retires the other runtime's own terminals, ready or pending, and refocuses a survivor", () => {
    let state = apply(makeState(), makeSnapshot([serverTerminal('agent-1', true)]), SERVER_ENV, NOW)
    state = apply(
      state,
      makeSnapshot([serverTerminal('a-ready', true), serverTerminal('a-pending', false)], {
        publicationEpoch: 'desktop-a-epoch'
      }),
      DESKTOP_A_ENV,
      NOW + 1000
    )
    expect(terminalIds(state)).toEqual([
      'web-terminal-a-pending',
      'web-terminal-a-ready',
      'web-terminal-agent-1'
    ])
    state = { ...state, activeTabIdByWorktree: { [WT]: 'web-terminal-a-ready' } }
    const retraction: RuntimeMobileSessionTabsRemovedResult = {
      ...desktopABrowserSnapshot([], 2),
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    state = apply(state, retraction, DESKTOP_A_ENV, NOW + 2000)
    expect(terminalIds(state)).toEqual(['web-terminal-agent-1'])
    expect(state.activeTabIdByWorktree[WT]).toBe('web-terminal-agent-1')
  })

  it('never keeps a shared terminal bound to a runtime that dropped it', () => {
    let state = apply(makeState(), makeSnapshot([serverTerminal('shared', true)]), SERVER_ENV, NOW)
    state = apply(
      state,
      makeSnapshot([serverTerminal('shared', true)], { publicationEpoch: 'desktop-a-epoch' }),
      DESKTOP_A_ENV,
      NOW + 1000
    )
    expect(state.tabsByWorktree[WT]?.[0]?.ptyId).toBe(`remote:${DESKTOP_A_ENV}@@pty-shared`)
    state = apply(state, desktopABrowserSnapshot([], 2), DESKTOP_A_ENV, NOW + 2000)
    expect(terminalIds(state)).toEqual([])
    state = apply(
      state,
      makeSnapshot([serverTerminal('shared', true)], { snapshotVersion: 2 }),
      SERVER_ENV,
      NOW + 3000
    )
    expect(state.tabsByWorktree[WT]?.[0]?.ptyId).toBe(`remote:${SERVER_ENV}@@pty-shared`)
  })

  it("keeps the server's chats when the other runtime's frame lists none", () => {
    const chat = (sessionId: string): RuntimeMobileSessionTabsResult['tabs'][number] => ({
      type: 'agent-session',
      id: `agent-session:${sessionId}`,
      title: 'Codex Chat',
      sessionId,
      agent: 'codex',
      isActive: false
    })
    const chatIds = (s: WebSessionTabsSyncState): string[] =>
      (s.unifiedTabsByWorktree[WT] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => tab.entityId)
        .sort()
    let state = apply(
      makeState(),
      makeSnapshot([chat('codex-1'), chat('codex-2')]),
      SERVER_ENV,
      NOW
    )
    state = apply(state, desktopABrowserSnapshot([desktopAPage], 1), DESKTOP_A_ENV, NOW + 1000)
    expect(chatIds(state)).toEqual(['codex-1', 'codex-2'])

    // A chat both runtimes publish keeps one row, and the server still retires its own.
    state = apply(
      state,
      desktopABrowserSnapshot([desktopAPage, chat('codex-1')], 2),
      DESKTOP_A_ENV,
      NOW + 2000
    )
    expect((state.unifiedTabsByWorktree[WT] ?? []).map((tab) => tab.id)).toEqual([
      ...new Set((state.unifiedTabsByWorktree[WT] ?? []).map((tab) => tab.id))
    ])
    state = apply(state, makeSnapshot([], { snapshotVersion: 2 }), SERVER_ENV, NOW + 3000)
    expect(chatIds(state)).toEqual(['codex-1'])
  })

  it('lets any runtime retire rows of a runtime that was removed', () => {
    let state = apply(makeState(), makeSnapshot([serverTerminal('agent-1', true)]), SERVER_ENV, NOW)
    const withServerRemoved: MirrorRowOwnershipState = {
      ...state,
      removedRuntimeEnvironmentIds: new Set([SERVER_ENV])
    }
    state = apply(
      withServerRemoved,
      desktopABrowserSnapshot([desktopAPage], 1),
      DESKTOP_A_ENV,
      NOW + 1000
    )
    expect(terminalIds(state)).toEqual([])
  })

  it('still retires a terminal the server itself stops publishing', () => {
    let state = apply(
      makeState(),
      makeSnapshot([serverTerminal('agent-1', true), serverTerminal('agent-2', true)]),
      SERVER_ENV,
      NOW
    )
    state = apply(state, desktopABrowserSnapshot([desktopAPage], 1), DESKTOP_A_ENV, NOW + 1000)
    state = apply(
      state,
      makeSnapshot([serverTerminal('agent-2', true)], { snapshotVersion: 2 }),
      SERVER_ENV,
      NOW + 2000
    )
    expect(terminalIds(state)).toHaveLength(1)
    expect(state.tabsByWorktree[WT]?.[0]?.ptyId).toBe(`remote:${SERVER_ENV}@@pty-agent-2`)
  })
})
