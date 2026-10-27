// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceGridViewCellRect } from '@/lib/workspace-grid-view-cell-rects'
import { computeWorkspaceGridViewCellRects } from '@/lib/workspace-grid-view-cell-rects'
import { TerminalSplitWorkspaceSurfaces } from './TerminalSplitWorkspaceSurfaces'
import type { TerminalController } from './use-terminal-controller'

type SurfaceProps = {
  worktreeId: string
  isVisible: boolean
  isFocused?: boolean
  gridViewCellRect?: WorkspaceGridViewCellRect | null
}

const mocks = vi.hoisted(() => ({
  surfaces: new Map<string, SurfaceProps>(),
  emptyCells: new Map<string, WorkspaceGridViewCellRect>(),
  openingEmptyCells: new Set<string>()
}))
vi.mock('./TerminalWorktreeSplitSurface', () => ({
  WorktreeSplitSurface: (props: SurfaceProps) => {
    mocks.surfaces.set(props.worktreeId, props)
    return null
  }
}))
vi.mock('./workspace-grid-view/WorkspaceGridViewEmptyCell', () => ({
  WorkspaceGridViewEmptyCell: (props: {
    workspaceId: string
    rect: WorkspaceGridViewCellRect
    isOpening: boolean
  }) => {
    mocks.emptyCells.set(props.workspaceId, props.rect)
    if (props.isOpening) {
      mocks.openingEmptyCells.add(props.workspaceId)
    }
    return null
  }
}))
vi.mock('./browser-pane/host-guest/browser-guest-paint-retention', () => ({
  useAnyBrowserGuestNeedsPaint: () => false
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ALPHA = 'repo::/alpha'
const BETA = 'repo::/beta'
const GAMMA = 'repo::/gamma'
const OUTSIDE = 'repo::/outside'
const ALL_IDS = [ALPHA, BETA, GAMMA, OUTSIDE]
const LAYOUT = { type: 'leaf', groupId: 'group-1' }

let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.surfaces.clear()
  mocks.emptyCells.clear()
  mocks.openingEmptyCells.clear()
})

async function renderSurfaces({
  activeId,
  visibleIds,
  activeView = 'terminal',
  withoutLayout = []
}: {
  activeId: string
  visibleIds: string[]
  activeView?: string
  withoutLayout?: string[]
}): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TerminalSplitWorkspaceSurfaces reads only the fields listed here; the rest of the controller is machinery this render never touches.
  const controller = {
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    activeGroupIdByWorktree: {},
    activeView,
    activityTerminalPortals: [],
    anyMountedWorktreeHasLayout: true,
    backgroundMountTabIdsByWorktreeRef: { current: new Map() },
    effectiveActiveLayout: withoutLayout.includes(activeId) ? null : LAYOUT,
    effectiveParkedTerminalWorktreeIds: new Set(),
    forceParkedTerminalWorktreeIds: new Set(),
    getEffectiveLayoutForWorktree: (id: string) => (withoutLayout.includes(id) ? null : LAYOUT),
    measurableBackgroundWorktreeIdsRef: { current: new Set() },
    mountedWorktreeIdsRef: { current: new Set(ALL_IDS) },
    renderedActiveWorktreeId: activeId,
    startupTerminalTabHold: null,
    visibleWorkspaceIds: visibleIds,
    workspaceSurfaces: ALL_IDS.map((id) => ({ id, path: `/${id}` }))
  } as unknown as TerminalController
  container = document.createElement('div')
  root = createRoot(container)
  await act(async () => root?.render(<TerminalSplitWorkspaceSurfaces controller={controller} />))
}

describe('TerminalSplitWorkspaceSurfaces on a workspace grid view', () => {
  it('shows every grid view member at once but gives focus only to the active one', async () => {
    await renderSurfaces({ activeId: BETA, visibleIds: [ALPHA, BETA, GAMMA] })

    expect(mocks.surfaces.get(ALPHA)).toMatchObject({ isVisible: true, isFocused: false })
    expect(mocks.surfaces.get(BETA)).toMatchObject({ isVisible: true, isFocused: true })
    expect(mocks.surfaces.get(GAMMA)).toMatchObject({ isVisible: true, isFocused: false })
    expect(mocks.surfaces.get(OUTSIDE)).toMatchObject({
      isVisible: false,
      isFocused: false,
      gridViewCellRect: null
    })
  })

  it('places members in grid view order, independent of sidebar order', async () => {
    await renderSurfaces({ activeId: ALPHA, visibleIds: [GAMMA, ALPHA] })

    const [first, second] = computeWorkspaceGridViewCellRects(2)
    expect(mocks.surfaces.get(GAMMA)?.gridViewCellRect).toEqual(first)
    expect(mocks.surfaces.get(ALPHA)?.gridViewCellRect).toEqual(second)
  })

  it('renders an empty cell for a member that has no tab layout yet', async () => {
    await renderSurfaces({ activeId: ALPHA, visibleIds: [ALPHA, BETA], withoutLayout: [BETA] })

    expect(mocks.surfaces.has(BETA)).toBe(false)
    expect(mocks.emptyCells.get(BETA)).toEqual(computeWorkspaceGridViewCellRects(2)[1])
    expect(mocks.emptyCells.has(ALPHA)).toBe(false)
  })

  it('keeps the single-workspace view when only the active workspace is visible', async () => {
    await renderSurfaces({ activeId: OUTSIDE, visibleIds: [OUTSIDE] })

    expect(mocks.surfaces.get(OUTSIDE)).toMatchObject({
      isVisible: true,
      isFocused: true,
      gridViewCellRect: null
    })
    expect(mocks.surfaces.get(ALPHA)).toMatchObject({ isVisible: false, gridViewCellRect: null })
    expect(mocks.emptyCells.size).toBe(0)
  })

  it('hides the grid view while another top-level view is open', async () => {
    await renderSurfaces({ activeId: ALPHA, visibleIds: [ALPHA, BETA], activeView: 'settings' })

    for (const id of [ALPHA, BETA]) {
      expect(mocks.surfaces.get(id)).toMatchObject({ isVisible: false, gridViewCellRect: null })
    }
    expect(mocks.emptyCells.size).toBe(0)
  })

  it('keeps the grid view on screen while the active member is still opening', async () => {
    await renderSurfaces({ activeId: BETA, visibleIds: [ALPHA, BETA], withoutLayout: [BETA] })

    // Why: an empty member can seed its first tab asynchronously after it becomes active.
    expect(container.firstElementChild?.classList.contains('hidden')).toBe(false)
    expect(mocks.surfaces.get(ALPHA)).toMatchObject({ isVisible: true, isFocused: false })
    expect(mocks.openingEmptyCells.has(BETA)).toBe(true)
  })

  it('still hides the single view while its workspace has no layout', async () => {
    await renderSurfaces({ activeId: OUTSIDE, visibleIds: [OUTSIDE], withoutLayout: [OUTSIDE] })

    expect(container.firstElementChild?.classList.contains('hidden')).toBe(true)
    expect(mocks.emptyCells.size).toBe(0)
  })
})
