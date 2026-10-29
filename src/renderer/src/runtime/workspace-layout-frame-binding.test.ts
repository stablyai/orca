import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import { endLayoutFramePositions } from './layout-frame-position'
import { holdTabPaneTree } from './layout-owner-pane-intents'
import { holdDrawnTabs } from './layout-owner-drawn-tab-holds'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'

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

  it('shows a resume outcome alone without touching any pane tree or binding', async () => {
    const { store, sync, first, send } = await boot()
    const layouts = store.getState().terminalLayoutsByTabId
    const ptyId = layouts['tab-shell']!.ptyIdsByLeafId?.[leaf(1)]
    expect(ptyId).toBeDefined()
    const next = structuredClone(first)
    const pane = next.tabs
      .find((tab) => tab.entityId === 'tab-shell')!
      .terminal!.panes.find((candidate) => candidate.leafId === leaf(1))!
    pane.resumeOutcome = 'restored'

    await send(next)

    // Same layouts object: no view rebinds, remounts or reattaches for an outcome.
    expect(store.getState().terminalLayoutsByTabId).toBe(layouts)
    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    expect(store.getState().terminalPaneResumeOutcomesByPaneKey).toEqual({
      [`tab-shell:${leaf(1)}`]: {
        ptyId,
        ...(pane.ptyGeneration !== undefined ? { ptyGeneration: pane.ptyGeneration } : {}),
        outcome: 'restored'
      }
    })
    sync.close()
  })

  it('writes nothing to the store when the store already shows those bindings', async () => {
    const { store, sync, first, send } = await boot()
    const layout = store.getState().terminalLayoutsByTabId['tab-shell']!
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-shell': {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leaf(1)]: 'pty-fresh' }
        }
      }
    })
    const writes = vi.fn()
    const stop = store.subscribe(writes)

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    stop()
    expect(writes).not.toHaveBeenCalled()
    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    sync.close()
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

  // Nonlive status preserves the bound terminal ID for restore.
  it('rebuilds nothing for a frame that only gives a bound pane a status', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const sleeping = structuredClone(first)
    const pane = sleeping.tabs.find((tab) => tab.entityId === 'tab-shell')!.terminal!.panes[0]!
    expect(pane.ptyId).toBeDefined()
    pane.status = 'sleeping'

    await send(sleeping)

    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    sync.close()
  })

  it('builds only its workspace, from the store’s view, for a frame that also renames', async () => {
    const { store, sync, first, send } = await boot()
    const renamed = rebound(first, 'tab-shell', leaf(1), 'pty-fresh')
    renamed.tabs.find((tab) => tab.entityId === 'tab-shell')!.customTitle = 'renamed'

    await send(renamed)

    expect(check.fullBuilt).toEqual([])
    expect(check.workspaceBuilt).toEqual([GIT_KEY])
    expect(
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')
    ).toMatchObject({ customTitle: 'renamed' })
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
  it('shows the status for that one pane, with no build and the pane tree untouched', async () => {
    const { store, sync, first, send } = await boot()
    const layoutsBefore = store.getState().terminalLayoutsByTabId
    const unbound = rebound(first, 'tab-shell', leaf(1), undefined)
    await send(unbound)
    const layouts = store.getState().terminalLayoutsByTabId
    check.forgetBuilds()

    await send(started(unbound, leaf(1), 'starting'))
    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({
      [`tab-shell:${leaf(1)}`]: { status: 'starting' }
    })
    await send(started(unbound, leaf(1), 'failed', 'shell not found'))

    expect([...check.fullBuilt, ...check.workspaceBuilt]).toEqual([])
    // Same tree objects: the pane's view is not remounted.
    expect(store.getState().terminalLayoutsByTabId).toBe(layouts)
    expect(layouts['tab-shell']!.root).toBe(layoutsBefore['tab-shell']!.root)
    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({
      [`tab-shell:${leaf(1)}`]: { status: 'failed', reason: 'shell not found' }
    })
    sync.close()
  })

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
