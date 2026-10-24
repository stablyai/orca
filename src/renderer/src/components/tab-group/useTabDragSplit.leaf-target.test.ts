/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { useTabDragSplit } from './useTabDragSplit'
import { moveTerminalTabIntoPaneInApp } from '../terminal-pane/terminal-tab-into-pane-deps'
import {
  BODY,
  C,
  dragEndEventAt,
  dragMoveEventAt,
  dragStartEventAt,
  GROUP,
  leafTargetState,
  PANEL,
  singleLeafTargetLayout,
  sourceDrag,
  TARGET,
  WT
} from './tab-drag-leaf-target-fixture'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The window-applied join exists only while the layout-owner switch is off.
const switchState = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return switchState.on
  }
}))
vi.mock('../terminal-pane/terminal-tab-into-pane-deps', () => ({
  moveTerminalTabIntoPaneInApp: vi.fn(() => Promise.resolve('moved'))
}))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height)
}

/** The group panel and body, and T's one mounted pane filling the body, as the layout would draw them. */
function mountGroupAndPane(): void {
  const panel = document.createElement('div')
  const body = document.createElement('div')
  body.dataset.tabGroupBodyId = GROUP
  body.dataset.worktreeId = WT
  panel.getBoundingClientRect = () => domRect(PANEL)
  body.getBoundingClientRect = () => domRect(BODY)
  panel.appendChild(body)
  const surface = document.createElement('div')
  surface.dataset.terminalTabId = TARGET
  const pane = document.createElement('div')
  pane.className = 'pane'
  pane.dataset.leafId = C
  pane.getBoundingClientRect = () => domRect(BODY)
  surface.appendChild(pane)
  document.body.append(panel, surface)
}

function renderDragHook(): { current: () => ReturnType<typeof useTabDragSplit> } {
  let latest: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    latest = useTabDragSplit({ worktreeId: WT })
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(Probe)))
  mounted.push({ container, root })
  return {
    current: () => {
      if (!latest) {
        throw new Error('useTabDragSplit did not render')
      }
      return latest
    }
  }
}

beforeEach(() => {
  switchState.on = false
  useAppStore.setState({
    ...leafTargetState({ target: singleLeafTargetLayout() }),
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: GROUP }
  })
  mountGroupAndPane()
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('useTabDragSplit leaf hover', () => {
  it("shows the join target while the pointer is over the edge of the shown tab's pane", () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 })))

    expect(drag.current().hoveredLeafTarget).toMatchObject({
      targetTabId: TARGET,
      leafId: C,
      zone: 'right',
      side: 'right',
      refusal: null
    })
    expect(drag.current().hoveredDropTarget).toBeNull()
    expect(drag.current().hoveredTabInsertion).toBeNull()
  })

  it('moves to the other edge, then clears in the center and in the Level 1 band', () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 500, y: 316 })))

    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 230, y: 316 })))
    expect(drag.current().hoveredLeafTarget).toMatchObject({ zone: 'left', side: 'left' })

    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 500, y: 316 })))
    expect(drag.current().hoveredLeafTarget).toBeNull()

    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 770, y: 316 })))
    expect(drag.current().hoveredLeafTarget).not.toBeNull()
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 900, y: 316 })))
    expect(drag.current().hoveredLeafTarget).toBeNull()
    expect(drag.current().hoveredDropTarget).toMatchObject({ groupId: GROUP, zone: 'right' })
  })

  it('shows the reason on a disabled target, and re-evaluates it on the next move', () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))
    useAppStore.setState({
      tabsByWorktree: {
        [WT]: (useAppStore.getState().tabsByWorktree[WT] ?? []).map((tab) =>
          tab.id === TARGET ? { ...tab, viewMode: 'chat' as const } : tab
        )
      }
    })

    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 })))
    expect(drag.current().hoveredLeafTarget).toMatchObject({ refusal: 'target_chat' })

    useAppStore.setState({
      tabsByWorktree: {
        [WT]: (useAppStore.getState().tabsByWorktree[WT] ?? []).map((tab) =>
          tab.id === TARGET ? { ...tab, viewMode: 'terminal' as const } : tab
        )
      }
    })
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 791, y: 316 })))
    expect(drag.current().hoveredLeafTarget).toMatchObject({ refusal: null })
  })

  it('clears with the drag when blur ends it', async () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 })))
    expect(drag.current().hoveredLeafTarget).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(drag.current().hoveredLeafTarget).toBeNull()
  })

  it('never offers a pane to a tab that is not a terminal', () => {
    const drag = renderDragHook()
    const editor = sourceDrag({ tabType: 'editor' })
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 }, { drag: editor })))
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 }, { drag: editor })))

    expect(drag.current().hoveredLeafTarget).toBeNull()
  })

  it('shows no join target in a layout-owner build, over the same pane edge', () => {
    switchState.on = true
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 })))

    expect(drag.current().hoveredLeafTarget).toBeNull()
  })

  it('does not join on a drop that lands before the overlay for that edge is committed', () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))

    // Inside one act the hover state is set but React has not drawn the overlay yet.
    act(() => {
      drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 }))
      drag.current().onDragEnd(dragEndEventAt({ x: 790, y: 316 }, { overGroupId: GROUP }))
    })

    expect(moveTerminalTabIntoPaneInApp).not.toHaveBeenCalled()
  })

  it('joins on a drop after the overlay for that edge is committed', () => {
    const drag = renderDragHook()
    act(() => drag.current().onDragStart(dragStartEventAt({ x: 790, y: 316 })))
    act(() => drag.current().onDragMove(dragMoveEventAt({ x: 790, y: 316 })))
    expect(drag.current().hoveredLeafTarget).not.toBeNull()

    act(() => drag.current().onDragEnd(dragEndEventAt({ x: 790, y: 316 }, { overGroupId: GROUP })))

    expect(moveTerminalTabIntoPaneInApp).toHaveBeenCalledTimes(1)
  })
})
