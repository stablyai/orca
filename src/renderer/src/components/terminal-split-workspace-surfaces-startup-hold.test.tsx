// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSplitWorkspaceSurfaces } from './TerminalSplitWorkspaceSurfaces'
import type { StartupTerminalTabHold } from './terminal/startup-terminal-tab-hold'
import type { TerminalController } from './use-terminal-controller'

const mocks = vi.hoisted(() => ({
  surfaceProps: new Map<string, ReadonlySet<string> | null>()
}))
vi.mock('./TerminalWorktreeSplitSurface', () => ({
  WorktreeSplitSurface: (props: {
    worktreeId: string
    activationDeferredMountTabIds: ReadonlySet<string> | null
  }) => {
    mocks.surfaceProps.set(props.worktreeId, props.activationDeferredMountTabIds)
    return null
  }
}))
vi.mock('./browser-pane/host-guest/browser-guest-paint-retention', () => ({
  useAnyBrowserGuestNeedsPaint: () => false
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const HELD_WORKTREE_ID = 'repo::/held'
const DEFERRED_WORKTREE_ID = 'repo::/deferred'
const OTHER_WORKTREE_ID = 'repo::/other'
const WORKTREE_IDS = [HELD_WORKTREE_ID, DEFERRED_WORKTREE_ID, OTHER_WORKTREE_ID]

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.surfaceProps.clear()
})

async function renderSurfaces(
  hold: StartupTerminalTabHold | null,
  deferred: Map<string, ReadonlySet<string>>
): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TerminalSplitWorkspaceSurfaces reads only the fields listed here; the rest of the controller is machinery this render never touches.
  const controller = {
    activationDeferredMountTabIdsByWorktreeRef: { current: deferred },
    activeGroupIdByWorktree: {},
    activeView: 'terminal',
    activityTerminalPortals: [],
    anyMountedWorktreeHasLayout: true,
    backgroundMountTabIdsByWorktreeRef: { current: new Map() },
    effectiveActiveLayout: { type: 'leaf', groupId: 'group-1' },
    effectiveParkedTerminalWorktreeIds: new Set(),
    forceParkedTerminalWorktreeIds: new Set(),
    getEffectiveLayoutForWorktree: () => ({ type: 'leaf', groupId: 'group-1' }),
    measurableBackgroundWorktreeIdsRef: { current: new Set() },
    mountedWorktreeIdsRef: { current: new Set(WORKTREE_IDS) },
    renderedActiveWorktreeId: HELD_WORKTREE_ID,
    startupTerminalTabHold: hold,
    workspaceSurfaces: WORKTREE_IDS.map((id) => ({ id, path: `/${id}` }))
  } as unknown as TerminalController
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => root?.render(<TerminalSplitWorkspaceSurfaces controller={controller} />))
}

describe('split workspace surfaces under a startup terminal hold', () => {
  it('hands each surface its parked-equivalent tabs: deferral set, else held tabs, else none', async () => {
    const hold: StartupTerminalTabHold = {
      worktreeId: HELD_WORKTREE_ID,
      heldTabIds: new Set(['held-tab'])
    }
    const deferredTabIds = new Set(['deferred-tab'])

    await renderSurfaces(hold, new Map([[DEFERRED_WORKTREE_ID, deferredTabIds]]))

    // Held tabs render no pane, so the surface must hand them to parked watchers.
    expect(mocks.surfaceProps.get(HELD_WORKTREE_ID)).toBe(hold.heldTabIds)
    expect(mocks.surfaceProps.get(DEFERRED_WORKTREE_ID)).toBe(deferredTabIds)
    expect(mocks.surfaceProps.get(OTHER_WORKTREE_ID)).toBeNull()
  })

  it('passes no held tabs once the hold is released', async () => {
    await renderSurfaces(null, new Map())

    expect(mocks.surfaceProps.get(HELD_WORKTREE_ID)).toBeNull()
  })
})
