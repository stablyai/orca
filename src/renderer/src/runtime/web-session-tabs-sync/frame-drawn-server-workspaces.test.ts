import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { applyWebSessionTabsSnapshot, applyWebSessionTabsSnapshots } from './snapshot-api'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import type { WebSessionTabsSyncState } from './state'
import {
  clearHostSessionTabIdMappings,
  resolveHostSessionTabIdForWebSessionTab
} from './tracking-mappings'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent
} from '../web-session-close-intent'
import { peekWebSessionFocusIntent, recordWebSessionFocusIntent } from '../web-session-focus-intent'
import {
  isFrameDrawnServerWorkspace,
  mirroredTerminalHandle,
  onMirroredTerminalHandlesChanged,
  resetFrameDrawnServerWorkspacesForTests,
  resyncMirroredServerWorkspace,
  setFrameDrawnServerWorkspaces
} from './frame-drawn-server-workspaces'

const hoisted = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  refresh: vi.fn<(environmentId: string, worktreeId: string) => Promise<void>>()
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return hoisted.layoutOwnerIsMain
  }
}))
vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('../web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: hoisted.refresh
}))

const OTHER_WT = 'repo::/other-worktree'
const MIRRORED_TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const MIRRORED_PANE_KEY = makePaneKey(MIRRORED_TAB_ID, LEAF_ID)

const LAYOUT_SLICES = [
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'tabBarOrderByWorktree',
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'openFiles',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'remoteBrowserPageHandlesByPageId',
  'activeTabIdByWorktree',
  'activeGroupIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabId',
  'activeFileId',
  'activeTabType',
  'pendingStartupByTabId',
  'automaticAgentResumeClaimsByTabId'
] as const

type Surface = { hostTabId: string; leafId: string; title: string; terminal: string | null }

function terminalSurface({ hostTabId, leafId, title, terminal }: Surface, working = false) {
  const base = {
    type: 'terminal' as const,
    id: `${hostTabId}::${leafId}`,
    title,
    parentTabId: hostTabId,
    leafId,
    isActive: true,
    ...(working
      ? {
          agentStatus: {
            state: 'working' as const,
            prompt: 'keep going',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'codex' as const,
            paneKey: makePaneKey(hostTabId, leafId),
            tabId: hostTabId,
            worktreeId: WT,
            terminalTitle: title,
            stateHistory: []
          }
        }
      : {})
  }
  return terminal === null
    ? { ...base, status: 'pending-handle' as const, terminal: null }
    : { ...base, status: 'ready' as const, terminal }
}

function shell(title: string, version: number, working = false, worktree = WT) {
  return makeSnapshot(
    [
      terminalSurface(
        { hostTabId: 'host-tab-1', leafId: LEAF_ID, title, terminal: 'terminal-1' },
        working
      )
    ],
    { worktree, snapshotVersion: version }
  )
}

function merge(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>
): WebSessionTabsSyncState {
  return { ...state, ...patch }
}

/** A store whose WT tree is the frames' own drawing (same ids, its own title). */
function frameDrawnStore(): WebSessionTabsSyncState {
  const mirrored = merge(
    makeState(),
    applyWebSessionTabsSnapshot(makeState(), shell('a', 1), ENV, NOW)
  )
  const frameTab = { ...mirrored.tabsByWorktree[WT]![0]!, title: 'drawn by frames' }
  setFrameDrawnServerWorkspaces(ENV, new Set([WT]))
  return { ...mirrored, tabsByWorktree: { ...mirrored.tabsByWorktree, [WT]: [frameTab] } }
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('frame-drawn server workspaces', () => {
  beforeEach(() => {
    hoisted.layoutOwnerIsMain = true
    hoisted.refresh.mockReset()
    resetWebSessionTabsSyncTestState()
    resetFrameDrawnServerWorkspacesForTests()
  })

  it('applies agent status but writes no layout slice for a frame-drawn workspace', () => {
    const store = frameDrawnStore()
    const patch = applyWebSessionTabsSnapshot(store, shell('b', 2, true), ENV, NOW)

    expect(patch).not.toBe(store)
    for (const slice of LAYOUT_SLICES) {
      expect(Object.hasOwn(patch, slice), slice).toBe(false)
    }
    expect(patch.agentStatusByPaneKey?.[MIRRORED_PANE_KEY]).toMatchObject({
      state: 'working',
      tabId: MIRRORED_TAB_ID,
      worktreeId: WT
    })
  })

  it('still mirrors every slice for another workspace of the same environment, batched', () => {
    const store = frameDrawnStore()
    const frameTree = store.tabsByWorktree[WT]
    const patch = applyWebSessionTabsSnapshots(
      store,
      [shell('b', 2, true), shell('other', 1, false, OTHER_WT)],
      ENV,
      NOW
    )

    expect(patch.tabsByWorktree?.[WT]).toBe(frameTree)
    expect(patch.tabsByWorktree?.[OTHER_WT]?.[0]?.title).toBe('other')
    expect(patch.agentStatusByPaneKey?.[MIRRORED_PANE_KEY]?.state).toBe('working')
  })

  it('drops unread markers for a tab the host retracted', () => {
    const store = { ...frameDrawnStore(), unreadTerminalTabs: { [MIRRORED_TAB_ID]: true as const } }
    const patch = applyWebSessionTabsSnapshot(
      store,
      makeSnapshot([], { snapshotVersion: 2 }),
      ENV,
      NOW
    )

    expect(patch.unreadTerminalTabs).toEqual({})
    expect(Object.hasOwn(patch, 'tabsByWorktree')).toBe(false)
  })

  it('indexes ready handles from every snapshot and notifies once per changed snapshot', async () => {
    const listener = vi.fn()
    onMirroredTerminalHandlesChanged(listener)
    const surfaces = (second: string | null, firstTerminal = 'terminal-1') =>
      makeSnapshot([
        terminalSurface({
          hostTabId: 'host-tab-1',
          leafId: LEAF_ID,
          title: 'a',
          terminal: firstTerminal
        }),
        ...(second === 'gone'
          ? []
          : [
              terminalSurface({
                hostTabId: 'host-tab-1',
                leafId: SECOND_LEAF_ID,
                title: 'b',
                terminal: second
              })
            ])
      ])
    const handle = (leafId: string) => mirroredTerminalHandle(ENV, WT, 'host-tab-1', leafId)

    applyWebSessionTabsSnapshot(makeState(), surfaces('terminal-2'), ENV, NOW)
    await flushMicrotasks()
    expect([handle(LEAF_ID), handle(SECOND_LEAF_ID)]).toEqual(['terminal-1', 'terminal-2'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(ENV, WT)

    applyWebSessionTabsSnapshot(makeState(), surfaces('terminal-2'), ENV, NOW)
    await flushMicrotasks()
    expect(listener).toHaveBeenCalledTimes(1)

    setFrameDrawnServerWorkspaces(ENV, new Set([WT]))
    applyWebSessionTabsSnapshot(makeState(), surfaces(null), ENV, NOW)
    await flushMicrotasks()
    expect(handle(SECOND_LEAF_ID)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)

    applyWebSessionTabsSnapshot(makeState(), surfaces('gone', 'terminal-3'), ENV, NOW)
    await flushMicrotasks()
    expect([handle(LEAF_ID), handle(SECOND_LEAF_ID)]).toEqual(['terminal-3', null])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('hands a workspace back: the snapshot replaces the frame tree in one write', async () => {
    let store = frameDrawnStore()
    const commits: WebSessionTabsSyncState[] = []
    const deliver = (snapshot: RuntimeMobileSessionTabsResult) => {
      if (decideWebSessionTabsSnapshot(snapshot, ENV).apply) {
        store = merge(store, applyWebSessionTabsSnapshot(store, snapshot, ENV, NOW))
        commits.push(store)
      }
    }
    // A frames-era snapshot advances freshness without touching the tree.
    deliver(shell('host tree', 2))
    expect(store.tabsByWorktree[WT]?.[0]?.title).toBe('drawn by frames')
    hoisted.refresh.mockImplementation(async () => deliver(shell('host tree', 2)))

    await resyncMirroredServerWorkspace(ENV, WT)

    expect(isFrameDrawnServerWorkspace(ENV, WT)).toBe(false)
    expect(hoisted.refresh).toHaveBeenCalledWith(ENV, WT, { errorMode: 'throw' })
    expect(commits.map((commit) => commit.tabsByWorktree[WT]?.map((tab) => tab.title))).toEqual([
      ['drawn by frames'],
      ['host tree']
    ])
  })

  it('keeps the id-mapping and intent ledgers running for a frame-drawn workspace', () => {
    const store = frameDrawnStore()
    clearHostSessionTabIdMappings(ENV, WT)
    const owner = { environmentId: ENV }
    recordWebSessionCloseIntent(owner, WT, 'host-tab-gone', NOW)
    recordWebSessionFocusIntent(owner, WT, 'host-tab-1', LEAF_ID)

    // Nothing but layout changed, so the store is untouched.
    expect(applyWebSessionTabsSnapshot(store, shell('b', 2), ENV, NOW)).toBe(store)
    expect(
      resolveHostSessionTabIdForWebSessionTab(store, {
        environmentId: ENV,
        worktreeId: WT,
        tabId: MIRRORED_TAB_ID
      })
    ).toBe('host-tab-1')
    expect(isWebSessionCloseIntentPending(owner, WT, 'host-tab-gone', NOW)).toBe(false)
    expect(peekWebSessionFocusIntent(owner, WT)).toBeNull()
  })

  it('changes nothing with the switch off', () => {
    hoisted.layoutOwnerIsMain = false
    setFrameDrawnServerWorkspaces(ENV, new Set([WT]))
    const patch = applyWebSessionTabsSnapshot(makeState(), shell('a', 1), ENV, NOW)

    expect(patch.tabsByWorktree?.[WT]?.[0]?.id).toBe(MIRRORED_TAB_ID)
    expect(mirroredTerminalHandle(ENV, WT, 'host-tab-1', LEAF_ID)).toBeNull()
  })
})
