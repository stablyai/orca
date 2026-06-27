/**
 * Remote-server ↔ local parity tests.
 *
 * Maps to docs/remote-server-parity-test-plan.md. These assert the DETERMINISTIC
 * behaviors of the remote-runtime session reconcile (the code that governs how
 * remote workspaces order tabs, take focus, mark disconnect, and react to host
 * state) so a remote workspace behaves 1:1 with a local one.
 *
 * Scope: the remote tab/session model is server-authoritative — the client
 * reconciles host snapshots via applyWebSessionTabsSnapshot. This suite drives
 * that reconcile directly. UI-heavy / two-host flows (splitting geometry, right
 * sidebar rendering, live screencast, mobile) are covered by the live checklist,
 * not here.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/types'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

type HostTerminal = { parentTab: string; leaf: string; active: boolean; title?: string }

function terminalSnapshotTab(t: HostTerminal): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${t.parentTab}::${t.leaf}`,
    title: t.title ?? t.parentTab,
    parentTabId: t.parentTab,
    leafId: t.leaf,
    isActive: t.active,
    status: 'ready',
    terminal: `${t.parentTab}-pty`
  }
}

function makeSnapshot(
  terminals: HostTerminal[],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  const tabs = terminals.map(terminalSnapshotTab)
  const active = terminals.find((t) => t.active)
  return {
    worktree: WT,
    publicationEpoch: `epoch-${overrides.snapshotVersion ?? 1}`,
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: active ? `${active.parentTab}::${active.leaf}` : null,
    activeTabType: active ? 'terminal' : null,
    tabGroups: [
      {
        id: 'host-group-1',
        activeTabId: active?.parentTab ?? null,
        tabOrder: terminals.map((t) => t.parentTab)
      }
    ],
    tabs,
    ...overrides
  }
}

// A local terminal tab + matching unified tab + group entry, as the store holds
// them, so a snapshot reconcile has a realistic prior state to compare against.
function localTerminal(parentTab: string, sortOrder: number, active: boolean) {
  const id = toWebTerminalSurfaceTabId(parentTab)
  const unified: Tab = {
    id,
    entityId: id,
    groupId: 'host-group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: parentTab,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: NOW + sortOrder,
    isPreview: false,
    isPinned: false
  }
  return {
    id,
    parentTab,
    active,
    storeTab: {
      id,
      ptyId: `remote:${ENV}@@${parentTab}-pty`,
      worktreeId: WT,
      title: parentTab,
      customTitle: null,
      color: null,
      sortOrder,
      createdAt: NOW + sortOrder
    },
    unified
  }
}

function stateWithLocalTerminals(
  locals: ReturnType<typeof localTerminal>[]
): WebSessionTabsSyncState {
  const active = locals.find((l) => l.active) ?? locals[0]
  return makeState({
    activeTabId: active?.id ?? null,
    activeTabIdByWorktree: active ? { [WT]: active.id } : {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    tabsByWorktree: { [WT]: locals.map((l) => l.storeTab) },
    unifiedTabsByWorktree: { [WT]: locals.map((l) => l.unified) },
    tabBarOrderByWorktree: { [WT]: locals.map((l) => l.id) },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'host-group-1',
          worktreeId: WT,
          activeTabId: active?.id ?? null,
          tabOrder: locals.map((l) => l.id),
          recentTabIds: locals.map((l) => l.id)
        }
      ]
    }
  })
}

function groupOrder(patch: Partial<WebSessionTabsSyncState>): string[] {
  return patch.groupsByWorktree?.[WT]?.[0]?.tabOrder ?? []
}
function groupActive(patch: Partial<WebSessionTabsSyncState>): string | null {
  return patch.groupsByWorktree?.[WT]?.[0]?.activeTabId ?? null
}

beforeEach(() => {
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebSessionFocusIntentForTests()
})

// ──────────────────────────────────────────────────────────────────────────
// Plan §3 — Terminal tab creation ordering (new tab lands rightmost, like local)
// ──────────────────────────────────────────────────────────────────────────
describe('parity §3: remote terminal create appends rightmost (matches local)', () => {
  it('a newly created remote terminal is ordered last, after existing tabs', () => {
    const prior = stateWithLocalTerminals([
      localTerminal('host-tab-1', 0, true),
      localTerminal('host-tab-2', 1, false)
    ])
    recordWebSessionFocusIntent(WT, `host-tab-3::${LEAF_C}`)
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([
        { parentTab: 'host-tab-1', leaf: LEAF_A, active: false },
        { parentTab: 'host-tab-2', leaf: LEAF_B, active: false },
        { parentTab: 'host-tab-3', leaf: LEAF_C, active: true }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    const order = groupOrder(patch)
    // Local rule: new tab appends to the end. The new one must be last.
    expect(order.at(-1)).toBe(toWebTerminalSurfaceTabId('host-tab-3'))
    expect(order).toEqual([
      toWebTerminalSurfaceTabId('host-tab-1'),
      toWebTerminalSurfaceTabId('host-tab-2'),
      toWebTerminalSurfaceTabId('host-tab-3')
    ])
  })

  it('preserves existing relative order when adding (no reshuffle)', () => {
    const prior = stateWithLocalTerminals([
      localTerminal('host-tab-1', 0, false),
      localTerminal('host-tab-2', 1, true)
    ])
    recordWebSessionFocusIntent(WT, `host-tab-3::${LEAF_C}`)
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([
        { parentTab: 'host-tab-1', leaf: LEAF_A, active: false },
        { parentTab: 'host-tab-2', leaf: LEAF_B, active: false },
        { parentTab: 'host-tab-3', leaf: LEAF_C, active: true }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    expect(groupOrder(patch)).toEqual([
      toWebTerminalSurfaceTabId('host-tab-1'),
      toWebTerminalSurfaceTabId('host-tab-2'),
      toWebTerminalSurfaceTabId('host-tab-3')
    ])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Plan §4 — Focus & activation (create focuses; status echo never steals focus)
// ──────────────────────────────────────────────────────────────────────────
describe('parity §4: remote create focuses new tab; echoes never steal focus', () => {
  it('a client-initiated create focuses the new terminal (intent honored)', () => {
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    recordWebSessionFocusIntent(WT, `host-tab-2::${LEAF_B}`)
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([
        { parentTab: 'host-tab-1', leaf: LEAF_A, active: false },
        { parentTab: 'host-tab-2', leaf: LEAF_B, active: true }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(toWebTerminalSurfaceTabId('host-tab-2'))
    expect(groupActive(patch)).toBe(toWebTerminalSurfaceTabId('host-tab-2'))
  })

  it('an unsolicited status echo (no intent) does NOT steal focus from current', () => {
    const prior = stateWithLocalTerminals([
      localTerminal('host-tab-1', 0, false), // agent tab
      localTerminal('host-tab-2', 1, true) // user is here
    ])
    // No focus intent recorded — this is an agent "thinking" echo marking tab-1 active.
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([
        { parentTab: 'host-tab-1', leaf: LEAF_A, active: true },
        { parentTab: 'host-tab-2', leaf: LEAF_B, active: false }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    // Focus stays on the user's current tab (tab-2), not the echoed tab-1.
    expect(groupActive(patch)).toBe(toWebTerminalSurfaceTabId('host-tab-2'))
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Plan §2 — Sidebar integrity: stale state ignored; newer snapshots applied
// ──────────────────────────────────────────────────────────────────────────
describe('parity §2: snapshot freshness (no split-brain from stale updates)', () => {
  it('ignores a stale lower-version snapshot after a newer version applied', () => {
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    const newer = makeSnapshot([{ parentTab: 'host-tab-1', leaf: LEAF_A, active: true }], {
      snapshotVersion: 3,
      publicationEpoch: 'epoch-x'
    })
    const older = makeSnapshot([{ parentTab: 'host-tab-1', leaf: LEAF_A, active: true }], {
      snapshotVersion: 2,
      publicationEpoch: 'epoch-x'
    })
    const first = applyFreshWebSessionTabsSnapshot(prior, newer, ENV, NOW + 10)
    const afterNewer = { ...prior, ...(first as Partial<WebSessionTabsSyncState>) }
    // Re-applying an older version of the same epoch must be a no-op (returns state).
    const second = applyFreshWebSessionTabsSnapshot(afterNewer, older, ENV, NOW + 20)
    expect(second).toBe(afterNewer)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Plan §11 — Browser tab create focuses the new browser (intent), like local.
// ──────────────────────────────────────────────────────────────────────────
describe('parity §11: remote browser create focuses the new browser tab', () => {
  it('honors focus intent for a newly created browser session tab', () => {
    const pageId = 'browser-page-1'
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    recordWebSessionFocusIntent(WT, pageId)
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([{ parentTab: 'host-tab-1', leaf: LEAF_A, active: false }], {
        activeTabId: pageId,
        activeTabType: 'browser',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: pageId,
            tabOrder: ['host-tab-1', pageId]
          }
        ],
        tabs: [
          terminalSnapshotTab({ parentTab: 'host-tab-1', leaf: LEAF_A, active: false }),
          {
            type: 'browser',
            id: pageId,
            title: 'example.com',
            browserWorkspaceId: pageId,
            browserPageId: pageId,
            url: 'https://example.com',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ]
      }),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    // Visible type flips to browser and the active browser workspace is the new page.
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('browser')
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBe(pageId)
  })

  it('a browser status echo without intent does not steal focus from a terminal', () => {
    const pageId = 'browser-page-1'
    const prior = makeState({
      activeTabId: toWebTerminalSurfaceTabId('host-tab-1'),
      activeTabIdByWorktree: { [WT]: toWebTerminalSurfaceTabId('host-tab-1') },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      tabsByWorktree: { [WT]: [localTerminal('host-tab-1', 0, true).storeTab] },
      unifiedTabsByWorktree: { [WT]: [localTerminal('host-tab-1', 0, true).unified] },
      tabBarOrderByWorktree: { [WT]: [toWebTerminalSurfaceTabId('host-tab-1')] },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'host-group-1',
            worktreeId: WT,
            activeTabId: toWebTerminalSurfaceTabId('host-tab-1'),
            tabOrder: [toWebTerminalSurfaceTabId('host-tab-1')],
            recentTabIds: [toWebTerminalSurfaceTabId('host-tab-1')]
          }
        ]
      },
      browserTabsByWorktree: {
        [WT]: [
          {
            id: pageId,
            worktreeId: WT,
            activePageId: pageId,
            pageIds: [pageId],
            url: 'https://example.com',
            title: 'example.com',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: NOW
          }
        ]
      }
    })
    // No intent — server snapshot marks the (pre-existing) browser active.
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([{ parentTab: 'host-tab-1', leaf: LEAF_A, active: false }], {
        activeTabId: pageId,
        activeTabType: 'browser',
        tabGroups: [{ id: 'host-group-1', activeTabId: pageId, tabOrder: ['host-tab-1', pageId] }],
        tabs: [
          terminalSnapshotTab({ parentTab: 'host-tab-1', leaf: LEAF_A, active: false }),
          {
            type: 'browser',
            id: pageId,
            title: 'example.com',
            browserWorkspaceId: pageId,
            browserPageId: pageId,
            url: 'https://example.com',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ]
      }),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    // No focus theft: the visible type must NOT flip to browser. The reconcile
    // emits no change for an unchanged field, so it's either absent (unchanged)
    // or still 'terminal' — never 'browser'.
    const nextType = patch.activeTabTypeByWorktree?.[WT] ?? 'terminal'
    expect(nextType).toBe('terminal')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Plan §1 — Lifecycle: an emptied host snapshot does not bootstrap phantom tabs
// when local terminals already exist (sleep/disconnect must not invent state).
// ──────────────────────────────────────────────────────────────────────────
describe('parity §1: empty host snapshot does not fabricate tabs', () => {
  it('an empty snapshot with existing local terminals does not add a phantom tab', () => {
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    const patch = applyWebSessionTabsSnapshot(
      prior,
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    // No new fabricated terminal ids beyond what existed.
    const order = groupOrder(patch)
    for (const id of order) {
      expect(id).toBe(toWebTerminalSurfaceTabId('host-tab-1'))
    }
  })
})
