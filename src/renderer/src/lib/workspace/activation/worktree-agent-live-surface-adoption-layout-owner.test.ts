import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { publishWorkspaceLayout } from '../../../../../shared/workspace-layout/workspace-layout-published'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { bootWindowFromPartitions } from '../../../app-shell/startup-window-view.test-fixture'
import { provideLayoutFrameTerminalPanes } from '../../../runtime/workspace-layout/frames/layout-frame-terminal-panes'
import {
  openWorkspaceLayoutFrameSync,
  type WorkspaceLayoutFrameSync
} from '../../../runtime/workspace-layout/frames/workspace-layout-frame-sync'

import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { adoptLiveWorkspacePtySurfaces } from './worktree-agent-live-surface-adoption'
import type { LiveTerminalSurfaceOwnerIndex } from '../ownership/worktree-live-terminal-surface-owners'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

type FrameDouble = { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null }
const frames = vi.hoisted((): FrameDouble => ({ onFrame: null }))
vi.mock('../../../runtime/workspace-layout/frames/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    frames.onFrame = onFrame
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const OTHER_PTY = `${GIT_KEY}@@aaaa0001`
const LEFT_PTY = `${GIT_KEY}@@aaaa0002`
const RIGHT_PTY = `${GIT_KEY}@@aaaa0003`

type TerminalSpec = {
  id: string
  entityId?: string
  leaves: [string, string?][]
  split?: 'vertical'
}

/** The window's copy: one shell tab. Main's: that tab and a split agent tab the window lacks,
 *  whose tab-bar id differs from its terminal id, as for a tab adopted from another window. */
function sessions(splitPtyIds: [string?, string?] = [LEFT_PTY, RIGHT_PTY]): {
  window: WorkspaceSessionState
  main: WorkspaceSessionState
} {
  const other: TerminalSpec = { id: 'tab-other', leaves: [[leaf(1), OTHER_PTY]] }
  const split: TerminalSpec = {
    id: 'entry-split',
    entityId: 'tab-split',
    leaves: [
      [leaf(2), splitPtyIds[0]],
      [leaf(3), splitPtyIds[1]]
    ],
    split: 'vertical'
  }
  return {
    window: addWorkspace(emptySession(), GIT_KEY, [{ id: 'group-a', tabs: [other] }]),
    main: addWorkspace(emptySession(), GIT_KEY, [{ id: 'group-a', tabs: [other, split] }])
  }
}

function snapshotOf(session: WorkspaceSessionState): WorkspaceLayoutChangeFrame {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return {
    type: 'snapshot',
    workspaces: Object.entries(layout.workspaces).map(([key, workspace]) => ({
      key,
      layout: publishWorkspaceLayout(workspace, 'local')
    }))
  }
}

const owners: LiveTerminalSurfaceOwnerIndex = new Map([
  [LEFT_PTY, { tabId: 'tab-split', paneKey: `tab-split:${leaf(2)}`, ptyId: LEFT_PTY }],
  [RIGHT_PTY, { tabId: 'tab-split', paneKey: `tab-split:${leaf(3)}`, ptyId: RIGHT_PTY }]
])

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('adopting live terminals in a layout-owner build', () => {
  let sync: WorkspaceLayoutFrameSync | null = null

  beforeEach(() => {
    sync?.close()
    sync = null
    provideLayoutFrameTerminalPanes({
      holdsTerminalPane: () => false,
      terminalTab: () => undefined
    })
  })

  it('makes no tab or pane of its own before frames draw; the frame then draws the bound tab', async () => {
    const { window: windowSession, main } = sessions()
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: windowSession }])
    sync = openWorkspaceLayoutFrameSync(store)
    provideLayoutFrameTerminalPanes(sync)
    // Main's snapshot is in, but the window has not started drawing from frames yet.
    frames.onFrame!(snapshotOf(main))
    await flushMicrotasks()
    const createTab = vi.spyOn(store.getState(), 'createTab')
    const setTabLayout = vi.spyOn(store.getState(), 'setTabLayout')

    const adoption = await adoptLiveWorkspacePtySurfaces(
      store.getState,
      GIT_KEY,
      [LEFT_PTY, RIGHT_PTY],
      async () => owners
    )

    expect(adoption).toEqual({ surfaced: true, declinedPtyIds: [] })
    expect(createTab).not.toHaveBeenCalled()
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((tab) => tab.id)).toEqual(['tab-other'])

    sync.start()
    await flushMicrotasks()
    const layout = store.getState().terminalLayoutsByTabId['tab-split']
    expect(layout?.root).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: leaf(2) },
      second: { type: 'leaf', leafId: leaf(3) }
    })
    expect(layout?.ptyIdsByLeafId).toEqual({ [leaf(2)]: LEFT_PTY, [leaf(3)]: RIGHT_PTY })
    // A later sweep finds both terminals owned.
    await expect(
      adoptLiveWorkspacePtySurfaces(store.getState, GIT_KEY, [LEFT_PTY, RIGHT_PTY], async () => {
        throw new Error('not asked: nothing is unbound')
      })
    ).resolves.toEqual({ surfaced: true, declinedPtyIds: [] })
  })

  it('counts a terminal shown, then the snapshot arriving after the sweep draws its tab with no new sweep', async () => {
    const { window: windowSession, main } = sessions()
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: windowSession }])
    sync = openWorkspaceLayoutFrameSync(store)
    provideLayoutFrameTerminalPanes(sync)
    sync.start()
    const createTab = vi.spyOn(store.getState(), 'createTab')
    const readOwners = vi.fn(async () => owners)

    await expect(
      adoptLiveWorkspacePtySurfaces(store.getState, GIT_KEY, [LEFT_PTY, RIGHT_PTY], readOwners)
    ).resolves.toEqual({ surfaced: true, declinedPtyIds: [] })

    frames.onFrame!(snapshotOf(main))
    await flushMicrotasks()

    expect(store.getState().terminalLayoutsByTabId['tab-split']?.ptyIdsByLeafId).toEqual({
      [leaf(2)]: LEFT_PTY,
      [leaf(3)]: RIGHT_PTY
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(readOwners).toHaveBeenCalledOnce()
  })
})
