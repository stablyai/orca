/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import type { TabDragItemData } from './tab-drag-data'
import { useTabDragSplit } from './useTabDragSplit'

const { captureSeed } = vi.hoisted(() => ({ captureSeed: vi.fn() }))

vi.mock('../terminal-pane/terminal-tab-window-transfer', () => ({
  captureTerminalWindowTransferSeed: captureSeed
}))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const WT = 'wt-window-detach'
const mounted: { container: HTMLDivElement; root: Root }[] = []
const detachTerminalWindow = vi.fn()

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeDragData(): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId: 'group-1',
    unifiedTabId: 'tab-1',
    visibleTabId: 'tab-1',
    tabType: 'terminal',
    label: 'Terminal'
  }
}

function dragEvent(activeData: TabDragItemData, pointer = { x: window.innerWidth + 20, y: 20 }) {
  return {
    active: {
      data: { current: activeData },
      rect: { current: { initial: null, translated: null } }
    },
    over: null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointer.x, clientY: pointer.y }
  }
}

function renderDragHook(enabled = true): ReturnType<typeof useTabDragSplit> {
  let result: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    result = useTabDragSplit({ worktreeId: WT, enabled })
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

function setActiveTab(tabId: string): void {
  useAppStore.setState((state) => ({
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [WT]: [{ ...state.groupsByWorktree[WT][0], activeTabId: tabId }]
    }
  }))
}

beforeEach(() => {
  captureSeed.mockReset()
  captureSeed.mockReturnValue({ ok: true, seed: { tabId: 'tab-1' } as TerminalWindowTransferSeed })
  detachTerminalWindow.mockReset()
  window.api = { terminalWindow: { detach: detachTerminalWindow } } as never
  const tabs = ['tab-1', 'tab-2', 'tab-3'].map(
    (id, index) =>
      ({
        id,
        groupId: 'group-1',
        worktreeId: WT,
        contentType: 'terminal',
        entityId: id,
        label: id,
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: index
      }) satisfies Tab
  )
  useAppStore.setState({
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: 'group-1' },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'group-1',
          worktreeId: WT,
          activeTabId: 'tab-1',
          tabOrder: tabs.map(({ id }) => id)
        }
      ]
    },
    unifiedTabsByWorktree: { [WT]: tabs }
  })
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.clearAllMocks()
})

describe('useTabDragSplit window detach lifecycle', () => {
  it('does not start or detach when tab dragging is disabled', () => {
    const drag = renderDragHook(false)
    const event = dragEvent(makeDragData())

    act(() => drag.onDragStart(event as never))
    act(() => drag.onDragEnd(event as never))

    expect(drag.isTabDragActiveRef.current).toBe(false)
    expect(detachTerminalWindow).not.toHaveBeenCalled()
  })

  it('does not let an older detach failure restore or clear a newer drag', async () => {
    const firstDetach = deferred<{ ok: false; error: string }>()
    detachTerminalWindow.mockReturnValueOnce(firstDetach.promise)
    const drag = renderDragHook()
    const activeData = makeDragData()
    const event = dragEvent(activeData)

    act(() => drag.onDragStart(event as never))
    act(() => setActiveTab('tab-2'))
    act(() => drag.onDragEnd(event as never))
    act(() => drag.onDragStart(event as never))
    act(() => setActiveTab('tab-3'))

    await act(async () => firstDetach.resolve({ ok: false, error: 'failed' }))

    expect(drag.isTabDragActiveRef.current).toBe(true)
    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-3')

    act(() => drag.onDragCancel())
    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-2')
  })

  it('starts only one detach for repeated drag-end delivery', async () => {
    const pendingDetach = deferred<{ ok: true; targetWindowId: number }>()
    detachTerminalWindow.mockReturnValue(pendingDetach.promise)
    const drag = renderDragHook()
    const event = dragEvent(makeDragData())

    act(() => drag.onDragStart(event as never))
    act(() => drag.onDragEnd(event as never))
    act(() => drag.onDragEnd(event as never))

    expect(detachTerminalWindow).toHaveBeenCalledOnce()
    expect(drag.isTabDragActiveRef.current).toBe(true)

    await act(async () => pendingDetach.resolve({ ok: true, targetWindowId: 2 }))
    expect(drag.isTabDragActiveRef.current).toBe(false)
  })

  it('restores the exact activation snapshot on failed detach and cancel', async () => {
    detachTerminalWindow.mockResolvedValueOnce({ ok: false, error: 'unavailable' })
    const drag = renderDragHook()
    const event = dragEvent(makeDragData())

    act(() => drag.onDragStart(event as never))
    act(() => setActiveTab('tab-2'))
    await act(async () => drag.onDragEnd(event as never))

    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-1')
    expect(drag.isTabDragActiveRef.current).toBe(false)
  })

  it('does not restore preview activation after successful detach', async () => {
    detachTerminalWindow.mockResolvedValueOnce({ ok: true, targetWindowId: 2 })
    const drag = renderDragHook()
    const event = dragEvent(makeDragData())

    act(() => drag.onDragStart(event as never))
    act(() => setActiveTab('tab-2'))
    await act(async () => drag.onDragEnd(event as never))

    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-2')
    expect(detachTerminalWindow).toHaveBeenCalledOnce()
    expect(useAppStore.getState().groupsByWorktree[WT][0].tabOrder).toContain('tab-1')
  })

  it('restores activation when pointercancel cleans a missed end', async () => {
    const drag = renderDragHook()
    const event = dragEvent(makeDragData())

    act(() => drag.onDragStart(event as never))
    act(() => setActiveTab('tab-2'))
    act(() => window.dispatchEvent(new Event('pointercancel')))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-1')
    expect(drag.isTabDragActiveRef.current).toBe(false)
  })

  it('resumes missed-end cleanup after an outside drag returns inside', async () => {
    const drag = renderDragHook()
    const activeData = makeDragData()

    act(() => drag.onDragStart(dragEvent(activeData) as never))
    act(() => drag.onDragMove(dragEvent(activeData) as never))
    act(() => window.dispatchEvent(new Event('blur')))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(drag.isTabDragActiveRef.current).toBe(true)

    act(() => drag.onDragMove(dragEvent(activeData, { x: 20, y: 20 }) as never))
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    expect(drag.isTabDragActiveRef.current).toBe(false)
  })

  it('cancels a blur timer before awaiting the detach result', async () => {
    const pendingDetach = deferred<{ ok: false; error: string }>()
    detachTerminalWindow.mockReturnValueOnce(pendingDetach.promise)
    const drag = renderDragHook()
    const activeData = makeDragData()
    const outsideEvent = dragEvent(activeData)

    act(() => drag.onDragStart(outsideEvent as never))
    act(() => setActiveTab('tab-2'))
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => drag.onDragEnd(outsideEvent as never))
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    expect(drag.isTabDragActiveRef.current).toBe(true)

    await act(async () => pendingDetach.resolve({ ok: false, error: 'failed' }))

    expect(detachTerminalWindow).toHaveBeenCalledOnce()
    expect(useAppStore.getState().groupsByWorktree[WT][0].activeTabId).toBe('tab-1')
    expect(drag.isTabDragActiveRef.current).toBe(false)
  })
})
