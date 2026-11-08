import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  GIT_KEY,
  leaf
} from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import type { LayoutFrameSlices } from '../../../store/workspace-layout/frames/workspace-layout-frame-slices'
import { endLayoutFramePositions } from './layout-frame-position'
import { holdTabPaneTree } from '../intents/layout-owner-pane-tree-holds'
import { holdDrawnTabs } from '../intents/layout-owner-drawn-tab-holds'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
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

const SLICES: (keyof LayoutFrameSlices)[] = [
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

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

/** The frame with one pane's terminal binding changed; absent `ptyId` unbinds it. */
function rebound(
  layout: PublishedWorkspaceLayout,
  tabId: string,
  leafId: string,
  ptyId: string | undefined
): PublishedWorkspaceLayout {
  const next = structuredClone(layout)
  const pane = next.tabs
    .find((tab) => tab.entityId === tabId)!
    .terminal!.panes.find((candidate) => candidate.leafId === leafId)!
  if (ptyId === undefined) {
    delete pane.ptyId
  } else {
    pane.ptyId = ptyId
  }
  return next
}

/** Boots a window shown from the session's frame; each later frame arrives as main sends it. */
async function boot() {
  const store = createTestStore()
  const session = localDesktopSession()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const first = publishedOf(session)
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot({ [GIT_KEY]: first }))
  sync.start()
  await settle()
  check.forgetBuilds()
  const send = async (layout: PublishedWorkspaceLayout, asSnapshot = false): Promise<void> => {
    stream.onFrame!(
      asSnapshot ? frames.snapshot({ [GIT_KEY]: layout }) : frames.records(GIT_KEY, layout)
    )
    await settle()
  }
  return { store, sync, first, send }
}

/** What a rebuild shows for these frames: a second snapshot redraws every workspace. */
async function rebuiltState(frames: PublishedWorkspaceLayout[]) {
  const { store, sync, send } = await boot()
  for (const frame of frames) {
    await send(frame, true)
  }
  sync.close()
  return store.getState()
}

const slicesOf = (state: Record<string, unknown>) =>
  Object.fromEntries(SLICES.map((slice) => [slice, state[slice]]))

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a frame that changes only panes’ terminal bindings', () => {
  // A respawn of a gone process: its pane is unbound, then bound again.
  it.each([
    ['unbinds a pane', [[leaf(1), undefined]]],
    [
      'unbinds then binds the same id again',
      [
        [leaf(1), undefined],
        [leaf(1), `${GIT_KEY}@@aaaa0001`]
      ]
    ],
    ['binds a new id', [[leaf(1), 'pty-fresh']]],
    ['unbinds the focused pane of a split', [[leaf(2), undefined]]]
  ] as const)('%s exactly as a rebuild shows it, without one', async (_, steps) => {
    const { store, sync, first, send } = await boot()
    const frames: PublishedWorkspaceLayout[] = []
    let frame = first
    for (const [leafId, ptyId] of steps) {
      frame = rebound(frame, 'tab-shell', leafId, ptyId)
      frames.push(frame)
      await send(frame)
    }
    const shown = store.getState()
    sync.close()

    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    const rebuilt = await rebuiltState(frames)
    expect(check.fullBuilt).not.toEqual([])
    expect(slicesOf(shown)).toEqual(slicesOf(rebuilt))
    // Presence: the binding the frame names is the store's.
    const [leafId, ptyId] = steps.at(-1)!
    expect(shown.terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leafId]).toBe(ptyId)
  })

  it('keeps a tab the window’s own pane command holds as the store has it, then shows its binding', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const release = holdTabPaneTree('tab-shell')

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    release()
    await settle()
    // Released, the tab shows the binding main wrote meanwhile.
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leaf(1)]).toBe(
      'pty-fresh'
    )
    sync.close()
  })

  it('keeps a tab the window drew before main answered as the store has it, then shows its binding', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const release = holdDrawnTabs([{ workspace: GIT_KEY, ids: ['tab-shell'] }])

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    release()
    await settle()
    // Released, the tab shows the binding main wrote meanwhile.
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leaf(1)]).toBe(
      'pty-fresh'
    )
    sync.close()
  })
})

/** The frame with one pane's start status set, or cleared when `status` is absent. */
function started(
  layout: PublishedWorkspaceLayout,
  leafId: string,
  status?: 'starting' | 'failed',
  reason?: string
): PublishedWorkspaceLayout {
  const next = structuredClone(layout)
  const pane = next.tabs
    .find((tab) => tab.entityId === 'tab-shell')!
    .terminal!.panes.find((candidate) => candidate.leafId === leafId)!
  delete pane.status
  delete pane.statusReason
  if (status) {
    pane.status = status
  }
  if (reason) {
    pane.statusReason = reason
  }
  return next
}

describe('a frame that changes only a pane’s start status', () => {
  it('drops the status once main binds the pane', async () => {
    const { store, sync, first, send } = await boot()
    const unbound = rebound(first, 'tab-shell', leaf(1), undefined)
    await send(started(unbound, leaf(1), 'starting'))
    expect(Object.keys(store.getState().terminalPaneStartsByPaneKey)).toEqual([
      `tab-shell:${leaf(1)}`
    ])

    await send(rebound(unbound, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leaf(1)]).toBe(
      'pty-fresh'
    )
    sync.close()
  })
})
