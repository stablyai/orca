import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import '../../../../shared/workspace-layout/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import type { WebSessionTabsSyncState } from './state'
import './tracking-mappings'
import '../web-session-close-intent'
import '../web-session-focus-intent'
import {
  isFrameDrawnServerWorkspace,
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

describe('frame-drawn server workspaces', () => {
  beforeEach(() => {
    hoisted.layoutOwnerIsMain = true
    hoisted.refresh.mockReset()
    resetWebSessionTabsSyncTestState()
    resetFrameDrawnServerWorkspacesForTests()
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
})
