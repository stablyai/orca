import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as WorkspaceSessionModule from '@/lib/workspace-session'
import type * as WorkspaceLayoutLoadModule from '../../../shared/workspace-layout/workspace-layout-load'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  addWorkspace,
  emptySession,
  GIT_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import { endLayoutFramePositions } from './layout-frame-position'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// The full build reads the window's session back and runs the Loader: a call means it ran.
vi.mock('@/lib/workspace-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceSessionModule>()
  return { ...actual, buildWorkspaceSessionPayload: vi.fn(actual.buildWorkspaceSessionPayload) }
})
vi.mock('../../../shared/workspace-layout/workspace-layout-load', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceLayoutLoadModule>()
  return {
    ...actual,
    loadWorkspaceLayoutWithoutReport: vi.fn(actual.loadWorkspaceLayoutWithoutReport)
  }
})

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const TABS = 100
const FRAME_SLICES: (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const leafOf = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

const terminalSpec = (index: number): { id: string; leaves: [string, string][] } => ({
  id: `tab-${index}`,
  leaves: [[leafOf(index), `pty-${index}`]]
})

function hundredTabs(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-a',
      tabs: Array.from({ length: TABS }, (_, index) => terminalSpec(index))
    }
  ])
}

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

async function boot() {
  const store = createTestStore()
  const session = hundredTabs()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const first = publishedOf(session)
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot({ [GIT_KEY]: first }, 0))
  sync.start()
  await settle()
  check.forgetBuilds()
  const writes = vi.fn()
  const stopWrites = store.subscribe(writes)
  /** Main's one frame for an operation that left the workspace as `layout`. */
  const send = async (layout: PublishedWorkspaceLayout): Promise<void> => {
    stream.onFrame!(frames.records(GIT_KEY, layout))
    await settle()
  }
  return { store, first, writes, send, close: () => (stopWrites(), sync.close()) }
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a records frame in the window', () => {
  it('shows 100 generated titles from one frame in one store update', async () => {
    const { store, first, writes, send, close } = await boot()
    const titled = structuredClone(first)
    titled.tabs.forEach((tab, index) => {
      tab.generatedTitle = `Title ${index}`
    })

    await send(titled)

    expect(writes).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree[GIT_KEY]!.map((tab) => tab.generatedTitle)).toEqual(
      titled.tabs.map((tab) => tab.generatedTitle)
    )
    close()
  })

  it('shows a frame of only tab rows without reading the window’s session back', async () => {
    const { store, first, writes, send, close } = await boot()
    // Exclude reference builds performed by apply checker; count only window calls.
    check.uninstall()
    vi.mocked(buildWorkspaceSessionPayload).mockClear()
    vi.mocked(loadWorkspaceLayoutWithoutReport).mockClear()
    const titled = structuredClone(first)
    titled.tabs.forEach((tab, index) => {
      tab.generatedTitle = `Title ${index}`
    })

    await send(titled)

    expect(writes).toHaveBeenCalledTimes(1)
    expect(buildWorkspaceSessionPayload).not.toHaveBeenCalled()
    expect(loadWorkspaceLayoutWithoutReport).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[GIT_KEY]![99]!.generatedTitle).toBe('Title 99')
    close()
  })

  it('shows a binding record without a rebuild', async () => {
    const { store, first, send, close } = await boot()
    const rebound = structuredClone(first)
    rebound.tabs[7]!.terminal!.panes[0]!.ptyId = 'pty-fresh'
    rebound.tabs[7]!.terminal!.panes[0]!.ptyGeneration = 2

    await send(rebound)

    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    expect(store.getState().terminalLayoutsByTabId['tab-7']!.ptyIdsByLeafId).toEqual({
      [leafOf(7)]: 'pty-fresh'
    })
    close()
  })

  it('rebinds a pane in its one store record, keeping its row and tree so the xterm stays mounted', async () => {
    const { store, first, send, close } = await boot()
    const before = store.getState()
    const rebound = structuredClone(first)
    rebound.tabs[7]!.terminal!.panes[0]!.ptyId = 'pty-fresh'

    await send(rebound)

    const after = store.getState()
    expect(FRAME_SLICES.filter((slice) => after[slice] !== before[slice])).toEqual([
      'terminalLayoutsByTabId'
    ])
    const changedLayouts = Object.keys(after.terminalLayoutsByTabId).filter(
      (tabId) => after.terminalLayoutsByTabId[tabId] !== before.terminalLayoutsByTabId[tabId]
    )
    expect(changedLayouts).toEqual(['tab-7'])
    expect(after.terminalLayoutsByTabId['tab-7']!.root).toBe(
      before.terminalLayoutsByTabId['tab-7']!.root
    )
    // The pane renderer is keyed by its row's id and generation: the same row, the same mount.
    expect(after.tabsByWorktree[GIT_KEY]![7]).toBe(before.tabsByWorktree[GIT_KEY]![7])
    expect(after.terminalLayoutsByTabId['tab-7']!.ptyIdsByLeafId).toEqual({
      [leafOf(7)]: 'pty-fresh'
    })
    close()
  })

  it('shows 100 single-binding frames, one per task, without building a workspace', async () => {
    const { store, first, send, close } = await boot()
    let layout = first
    for (let index = 0; index < TABS; index += 1) {
      layout = structuredClone(layout)
      layout.tabs[index]!.terminal!.panes[0]!.ptyId = `pty-respawned-${index}`
      await send(layout)
    }

    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    const bindings = store.getState().terminalLayoutsByTabId
    expect(
      Array.from({ length: TABS }, (_, index) => bindings[`tab-${index}`]!.ptyIdsByLeafId)
    ).toEqual(
      Array.from({ length: TABS }, (_, index) => ({ [leafOf(index)]: `pty-respawned-${index}` }))
    )
    close()
  })

  it('writes nothing for a respawn under the same id: only its generation rose', async () => {
    const { first, writes, send, close } = await boot()
    const respawned = structuredClone(first)
    respawned.tabs[3]!.terminal!.panes[0]!.ptyGeneration = 2

    await send(respawned)

    expect(writes).not.toHaveBeenCalled()
    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    close()
  })
})
