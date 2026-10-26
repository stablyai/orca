// Exercise deterministic server-authoritative reconcile against local tab ordering/focus/disconnect semantics (remote-server-parity-test-plan.md). Live checklist covers geometry, sidebar, screencast, mobile and two-host UI flows.
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/tab-types'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
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
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    editorBuffers: {},
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

// Seed realistic prior terminal/unified-tab/group state for snapshot reconciliation.
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

describe('parity §3: remote terminal create appends rightmost (matches local)', () => {
  it('a newly created remote terminal is ordered last, after existing tabs', () => {
    const prior = stateWithLocalTerminals([
      localTerminal('host-tab-1', 0, true),
      localTerminal('host-tab-2', 1, false)
    ])
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, `host-tab-3::${LEAF_C}`)
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
})

describe('parity §4: remote create focuses new tab; echoes never steal focus', () => {
  it('a client-initiated create focuses the new terminal (intent honored)', () => {
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, `host-tab-2::${LEAF_B}`)
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
      localTerminal('host-tab-1', 0, false),
      localTerminal('host-tab-2', 1, true)
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
    // Status echoes cannot steal focus; client-owned placement leaves groups unchanged.
    const effectiveGroups = patch.groupsByWorktree?.[WT] ?? prior.groupsByWorktree[WT]
    expect(effectiveGroups?.[0]?.activeTabId).toBe(toWebTerminalSurfaceTabId('host-tab-2'))
  })
})

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
    const second = applyFreshWebSessionTabsSnapshot(afterNewer, older, ENV, NOW + 20)
    expect(second).toBe(afterNewer)
  })
})

describe('parity §11: remote browser create focuses the new browser tab', () => {
  it('honors focus intent for a newly created browser session tab', () => {
    const pageId = 'browser-page-1'
    const prior = stateWithLocalTerminals([localTerminal('host-tab-1', 0, true)])
    recordWebSessionFocusIntent(
      { environmentId: ENV },
      WT,
      pageId,
      undefined,
      toWebTerminalSurfaceTabId('host-tab-1')
    )
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
    // Unchanged reconcile fields may be absent; visible type must remain terminal, never browser.
    const nextType = patch.activeTabTypeByWorktree?.[WT] ?? 'terminal'
    expect(nextType).toBe('terminal')
  })
})
