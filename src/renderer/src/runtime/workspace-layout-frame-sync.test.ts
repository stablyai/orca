import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import {
  localDesktopSession,
  WORKSPACE_LAYOUT_PROFILES
} from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  emptySession,
  GIT_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import {
  afterLayoutFrame,
  endLayoutFramePositions,
  layoutFramesFlowing
} from './layout-frame-position'
import { holdTabPaneTree, requestTabPaneTreeRedraw } from './layout-owner-pane-intents'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import {
  layoutSnapshotFrame,
  mainLayoutFrameSender,
  mainLoadedLayouts
} from './main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onStatus: ((status: { state: string }) => void) | null
  onPosition: ((seq: number) => void) | null
  close: () => void
}
const stream = vi.hoisted((): StreamDouble => ({
  onFrame: null,
  onStatus: null,
  onPosition: null,
  close: () => {}
}))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    onStatus: (status: { state: string }) => void,
    onPosition: (seq: number) => void
  ) => {
    stream.onFrame = onFrame
    stream.onStatus = onStatus
    stream.onPosition = onPosition
    return { close: stream.close }
  }
}))

createStoreSessionMockApi()

const SLICES: (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'remoteBrowserPageHandlesByPageId',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function bootWithFrames(hostId: ExecutionHostId, session: WorkspaceSessionState) {
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId, session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const layouts = mainLoadedLayouts(hostId, session)
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot(layouts))
  return { store, sync, layouts, frames }
}

/** Fixtures whose frames differ from the restore, as the frame parity test lists. */
const FRAME_DIFFERENCE_FIXTURES = new Set([
  'row without a tab-bar entry or a terminal',
  'row without a tab-bar entry or a terminal, selected',
  'row without a tab-bar entry, its terminal in a workspace slept at shutdown',
  'row without a tab-bar entry, its terminal only on a relay',
  'row without a tab-bar entry, with a sleeping agent',
  'row bound only through its pane, without a tab-bar entry',
  'legacy surface tombstone on a pane still showing its terminal',
  'tab-bar label differing from the row title',
  'row without a tab-bar entry, still bound to a terminal',
  'legacy split row sharing one pane’s terminal with a tab-bar tab',
  'session from before the tab bar, with an open file',
  'session from before the tab bar, a row with no terminal'
])

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('the window drawn from layout frames', () => {
  it.each(
    [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]
      .filter((profile) => !FRAME_DIFFERENCE_FIXTURES.has(profile.name))
      .map((profile) => [profile.name, profile] as const)
  )('startup from the first snapshot changes nothing restore showed: %s', async (_, profile) => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: profile.hostId, session: profile.build() }])
    const before = store.getState()
    const sync = openWorkspaceLayoutFrameSync(store)
    stream.onFrame!(layoutSnapshotFrame(mainLoadedLayouts(profile.hostId, profile.build())))
    sync.start()
    const after = store.getState()
    expect(SLICES.filter((slice) => after[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('shows a structure change main publishes, keeping what only the window knows', async () => {
    const session = localDesktopSession()
    const { store, sync, layouts, frames } = await bootWithFrames('local', session)
    sync.start()
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [GIT_KEY]: store.getState().tabsByWorktree[GIT_KEY]!.map((tab) =>
          tab.id === 'tab-shell'
            ? {
                ...tab,
                ptyId: 'live-pty',
                pendingActivationSpawn: true,
                restoredFromSession: undefined
              }
            : tab
        )
      }
    })
    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!(frames.records(GIT_KEY, renamed))
    await flushMicrotasks()
    const shell = store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!
    expect(shell).toMatchObject({
      customTitle: 'renamed',
      ptyId: 'live-pty',
      pendingActivationSpawn: true
    })
    // Restore marks every row it builds; a row whose terminal bound since must not get it back.
    expect(shell).not.toHaveProperty('restoredFromSession')
    sync.close()
  })

  it('keeps the window’s pane remount generation through a structure frame: it is the window’s', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    store.getState().remountTerminalTabForRecovery('tab-shell')
    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!(frames.records(GIT_KEY, renamed))
    await flushMicrotasks()
    expect(
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')
    ).toMatchObject({ customTitle: 'renamed', generation: 1 })
    sync.close()
  })

  it('answers main’s terminal tab by its terminal id, shown or not, until the stream ends', async () => {
    const { sync, layouts } = await bootWithFrames('local', localDesktopSession())
    const shell = layouts[GIT_KEY]!.tabs.find((tab) => tab.entityId === 'tab-shell')!
    expect(sync.terminalTab(GIT_KEY, 'tab-shell')).toBe(shell)
    expect(sync.terminalTab(GIT_KEY, 'missing')).toBeUndefined()
    stream.onStatus!({ state: 'lost' })
    expect(sync.terminalTab(GIT_KEY, 'tab-shell')).toBeUndefined()
    sync.close()
  })

  it('runs a reply waiting on a frame after the store shows it, and every waiter when the stream ends', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    stream.onFrame!(frames.records(GIT_KEY, layouts[GIT_KEY]!, 1))
    stream.onPosition!(1)
    await flushMicrotasks()
    const shellTitle = () =>
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.customTitle
    const seen: (string | null | undefined)[] = []
    afterLayoutFrame(2, () => seen.push(shellTitle()))
    expect(seen).toEqual([])

    const renamed = structuredClone(layouts[GIT_KEY]!)
    renamed.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'renamed'
    stream.onFrame!(frames.records(GIT_KEY, renamed, 2))
    stream.onPosition!(2)
    await flushMicrotasks()
    expect(seen).toEqual(['renamed'])

    const released = vi.fn()
    afterLayoutFrame(9, released)
    stream.onStatus!({ state: 'lost' })
    expect(released).toHaveBeenCalledTimes(1)
    // A position counted before the end but noted after it does not reopen the wait.
    stream.onPosition!(4)
    await flushMicrotasks()
    const later = vi.fn()
    afterLayoutFrame(10, later)
    expect(later).toHaveBeenCalledTimes(1)
    sync.close()
  })

  it('shows main’s pane tree at once, except a tab the window’s own pane command holds', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    const shellRoot = () => store.getState().terminalLayoutsByTabId['tab-shell']!.root
    const withRatio = (ratio: number) => {
      const next = structuredClone(layouts[GIT_KEY]!)
      const root = next.tabs.find((tab) => tab.id === 'tab-shell')!.terminal!.root!
      if (root.type === 'split') {
        root.ratio = ratio
      }
      return next
    }
    expect(shellRoot()?.type).toBe('split')

    stream.onFrame!(frames.records(GIT_KEY, withRatio(0.2)))
    await flushMicrotasks()
    expect(shellRoot()).toMatchObject({ ratio: 0.2 })

    const release = holdTabPaneTree('tab-shell')
    stream.onFrame!(frames.records(GIT_KEY, withRatio(0.7)))
    await flushMicrotasks()
    expect(shellRoot()).toMatchObject({ ratio: 0.2 })

    release()
    await flushMicrotasks()
    expect(shellRoot()).toMatchObject({ ratio: 0.7 })
    sync.close()
  })

  it('shows main’s pane tree going back to one the window showed before', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    const shellRoot = () => store.getState().terminalLayoutsByTabId['tab-shell']!.root
    const original = shellRoot()
    const changed = structuredClone(layouts[GIT_KEY]!)
    const root = changed.tabs.find((tab) => tab.id === 'tab-shell')!.terminal!.root!
    if (root.type === 'split') {
      root.ratio = 0.15
    }
    stream.onFrame!(frames.records(GIT_KEY, changed))
    await flushMicrotasks()
    expect(shellRoot()).toMatchObject({ ratio: 0.15 })

    // Same structure as the frame shown before: its pane tree still shows.
    stream.onFrame!(frames.records(GIT_KEY, structuredClone(layouts[GIT_KEY]!)))
    await flushMicrotasks()
    expect(shellRoot()).toEqual(original)
    sync.close()
  })

  it('keeps the window’s own pane trees once the stream has ended', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    await flushMicrotasks()
    // A frame still queued when the stream ends.
    stream.onFrame!(frames.records(GIT_KEY, structuredClone(layouts[GIT_KEY]!)))
    stream.onStatus!({ state: 'lost' })
    const drawn = { type: 'leaf' as const, leafId: 'drawn-by-the-window' }
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-shell': { ...store.getState().terminalLayoutsByTabId['tab-shell']!, root: drawn }
      }
    })

    requestTabPaneTreeRedraw('tab-shell')
    await flushMicrotasks()
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.root).toEqual(drawn)

    sync.close()
  })

  it('after a lost stream reopens, its snapshot redraws every workspace from main', async () => {
    const { store, sync, layouts } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    await flushMicrotasks()
    stream.onStatus!({ state: 'lost' })
    expect(layoutFramesFlowing()).toBe(false)
    // Drawn while no frame came; main's snapshot does not have it.
    const drawn = { type: 'leaf' as const, leafId: 'drawn-by-the-window' }
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-shell': { ...store.getState().terminalLayoutsByTabId['tab-shell']!, root: drawn }
      }
    })

    stream.onStatus!({ state: 'connecting' })
    expect(layoutFramesFlowing()).toBe(true)
    const renamed = structuredClone(layouts)
    renamed[GIT_KEY]!.tabs.find((tab) => tab.id === 'tab-unbound')!.customTitle = 'from main'
    stream.onFrame!(layoutSnapshotFrame(renamed))
    stream.onStatus!({ state: 'live' })
    await flushMicrotasks()

    const rows = store.getState().tabsByWorktree[GIT_KEY]!
    expect(rows.find((tab) => tab.id === 'tab-unbound')!.customTitle).toBe('from main')
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.root).not.toEqual(drawn)
    expect(sync.terminalTab(GIT_KEY, 'tab-shell')).toBeDefined()
    sync.close()
  })

  it('shows a live title change of the focused pane without rebuilding structure', async () => {
    const { store, sync, layouts, frames } = await bootWithFrames('local', localDesktopSession())
    sync.start()
    const titled = structuredClone(layouts[GIT_KEY]!)
    const shell = titled.tabs.find((tab) => tab.id === 'tab-shell')!
    const focused = store.getState().terminalLayoutsByTabId['tab-shell']!.activeLeafId
    shell.terminal!.panes = shell.terminal!.panes.map((pane) => ({
      ...pane,
      liveTitle: pane.leafId === focused ? 'vim notes.md' : 'other pane'
    }))
    const before = store.getState()
    stream.onFrame!(frames.records(GIT_KEY, titled))
    await flushMicrotasks()
    const after = store.getState()
    expect(after.tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.title).toBe(
      'vim notes.md'
    )
    expect(after.groupsByWorktree).toBe(before.groupsByWorktree)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
    sync.close()
  })

  it('leaves a paired server’s workspaces to the mirror', async () => {
    const profile = WORKSPACE_LAYOUT_PROFILES.find(
      (entry) => entry.name === 'remote server partition'
    )!
    const { store, sync, layouts, frames } = await bootWithFrames(profile.hostId, profile.build())
    sync.start()
    const before = store.getState()
    const [key, layout] = Object.entries(layouts)[0]!
    stream.onFrame!(frames.records(key, { ...layout, tabs: [], groups: [] }))
    await flushMicrotasks()
    expect(SLICES.filter((slice) => store.getState()[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('leaves restore in place when the stream ends before its snapshot', async () => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: localDesktopSession() }])
    const before = store.getState()
    const sync = openWorkspaceLayoutFrameSync(store)
    sync.start()
    stream.onStatus!({ state: 'refused' })
    await flushMicrotasks()
    expect(SLICES.filter((slice) => store.getState()[slice] !== before[slice])).toEqual([])
    sync.close()
  })

  it('gives a moved editor tab an older build saved under its old workspace the right id', async () => {
    // Before #29930 a tab Orca moved to its file's workspace kept the source's worktree id.
    const session = localDesktopSession()
    const ownedId = buildOwnedEditorFileId('/Users/dev/orca/src/app.ts', GIT_KEY, null)
    const entry = session.unifiedTabs![GIT_KEY]!.find((tab) => tab.contentType === 'editor')!
    entry.entityId = ownedId
    entry.worktreeId = 'repo-2::/Users/dev/other'
    const { store, sync } = await bootWithFrames('local', session)
    sync.start()
    await flushMicrotasks()
    const tabs = store.getState().unifiedTabsByWorktree[GIT_KEY]!
    expect(tabs.find((tab) => tab.entityId === ownedId)).toMatchObject({ worktreeId: GIT_KEY })
    expect(tabs.every((tab) => tab.worktreeId === GIT_KEY)).toBe(true)
    sync.close()
  })

  it('shows a workspace only main held (a CLI-started tab) once the window first opens it', async () => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: emptySession() }])
    const sync = openWorkspaceLayoutFrameSync(store)
    const layouts = mainLoadedLayouts('local', localDesktopSession())
    stream.onFrame!(layoutSnapshotFrame(layouts))
    sync.start()
    await flushMicrotasks()
    expect(store.getState().tabsByWorktree[GIT_KEY]).toBeUndefined()
    // The first visit gives the workspace its empty root group; no frame arrives after it.
    store.getState().ensureWorktreeRootGroup(GIT_KEY)
    await flushMicrotasks()
    // Exactly main's terminal tabs: the visit adds none of its own.
    const mainTerminals = layouts[GIT_KEY]!.tabs.flatMap((tab) =>
      tab.terminal ? [tab.entityId] : []
    )
    expect(mainTerminals).toContain('tab-shell')
    expect(store.getState().tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual(mainTerminals)
    sync.close()
  })

  it('started before its snapshot, shows the snapshot when it arrives', async () => {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: localDesktopSession() }])
    const sync = openWorkspaceLayoutFrameSync(store)
    sync.start()
    const layouts = mainLoadedLayouts('local', localDesktopSession())
    layouts[GIT_KEY]!.tabs.find((tab) => tab.id === 'tab-shell')!.customTitle = 'from main'
    stream.onFrame!(layoutSnapshotFrame(layouts))
    await flushMicrotasks()
    expect(
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')!.customTitle
    ).toBe('from main')
    sync.close()
  })
})
