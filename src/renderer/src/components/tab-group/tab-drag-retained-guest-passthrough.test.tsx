/**
 * @vitest-environment happy-dom
 *
 * The drag half of the gesture is real here — useTabDragSplit's own handlers, its missed-end
 * listeners and its root teardown — and so is the client-hosted retained host on the other side.
 * Nothing about which elements go click-through is mocked, which is the part a mocked
 * acquireWebviewsDragPassthrough leaves unasserted.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures,
  type RetainedHostFixture
} from '../browser-pane/browser-client-page-retained-host-fixture'
import { useTabDragSplit, type TabDragItemData } from './useTabDragSplit'

vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const WT = 'wt-1'
const mounted: { container: HTMLDivElement; root: Root }[] = []

function dragData(): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId: 'group-1',
    unifiedTabId: 'tab-1',
    visibleTabId: 'tab-1',
    tabType: 'browser',
    label: 'one'
  }
}

function dragStartEvent() {
  return { active: { data: { current: dragData() }, rect: { current: { initial: null } } } }
}

function dragEndEvent(): DragEndEvent {
  return {
    active: { data: { current: dragData() }, rect: { current: { initial: null } } },
    over: null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: 0, clientY: 0 }
  } as unknown as DragEndEvent
}

function renderDragHook(): ReturnType<typeof useTabDragSplit> {
  let result: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    result = useTabDragSplit({ worktreeId: WT })
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(Probe)))
  mounted.push({ container, root })
  if (!result) {
    throw new Error('useTabDragSplit did not render')
  }
  return result
}

async function retainedGuest(): Promise<RetainedHostFixture> {
  const rig = createRetainedHostFixture()
  await rig.mount()
  rig.attach()
  return rig
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  disposeRetainedHostFixtures()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('tab drag passthrough over a client-hosted retained guest', () => {
  it('makes the retained host click-through for the length of the drag', async () => {
    const rig = await retainedGuest()
    const drag = renderDragHook()

    act(() => drag.onDragStart(dragStartEvent() as never))

    expect(rig.host().style.pointerEvents).toBe('none')

    act(() => drag.onDragEnd(dragEndEvent()))

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('releases the retained host when the drag is cancelled', async () => {
    const rig = await retainedGuest()
    const drag = renderDragHook()

    act(() => drag.onDragStart(dragStartEvent() as never))
    expect(rig.host().style.pointerEvents).toBe('none')

    act(() => drag.onDragCancel())

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('releases the retained host from the missed-end fallback', async () => {
    const rig = await retainedGuest()
    const drag = renderDragHook()

    act(() => drag.onDragStart(dragStartEvent() as never))
    expect(rig.host().style.pointerEvents).toBe('none')

    act(() => {
      window.dispatchEvent(new Event('pointerup'))
      vi.advanceTimersByTime(1)
    })

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('releases the retained host when the drag root is torn down', async () => {
    const rig = await retainedGuest()
    const drag = renderDragHook()

    act(() => drag.onDragStart(dragStartEvent() as never))
    expect(rig.host().style.pointerEvents).toBe('none')

    act(() => drag.setDragRootNode(null))

    expect(rig.host().style.pointerEvents).toBe('auto')
  })
})
