/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let terminalPaneRenderCount = 0
let terminalPaneProps: { onPtyExit?: (ptyId: string, exitCode?: number) => void } | null = null
const markUnverifiedPtyLoss = vi.fn()
vi.mock('./TerminalPane', () => ({
  default: (props: { onPtyExit?: (ptyId: string, exitCode?: number) => void }) => {
    terminalPaneProps = props
    terminalPaneRenderCount += 1
    return null
  }
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ pendingStartupByTabId: {}, markUnverifiedPtyLoss })
  })
}))

import { TerminalOverlaySlot } from './TerminalOverlaySlot'

const GROUP_ID = 'group-react185'
const TAB_ID = 'tab-react185'

function createRect({
  top = 0,
  left = 0,
  width = 800,
  height = 600
}: Partial<Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>> = {}): DOMRect {
  return {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  }
}

const PARENT_RECT = createRect()

let capturedResizeCallback: (() => void) | null = null
let capturedMutationCallback: (() => void) | null = null
let container: HTMLDivElement
let bodyEl: HTMLDivElement
let bodyRect: DOMRect
let root: Root
let canvasViewport: HTMLDivElement | null = null

class CapturingResizeObserver {
  constructor(cb: () => void) {
    capturedResizeCallback = cb
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class CapturingMutationObserver {
  constructor(cb: () => void) {
    capturedMutationCallback = cb
  }
  observe(): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] {
    return []
  }
}

function renderSlot(): void {
  root = createRoot(container)
  act(() => {
    root.render(
      <TerminalOverlaySlot
        terminalTabId={TAB_ID}
        terminalGeneration={0}
        worktreeId="wt-1"
        worktreePath="wt-1"
        startupCwd={undefined}
        groupId={GROUP_ID}
        isWorktreeActive
        isVisible
        isActive
        activityTerminalPortal={null}
        onFocusOwningGroup={vi.fn()}
        consumeSuppressedPtyExit={() => false}
        leaveWorktreeIfEmpty={vi.fn()}
      />
    )
  })
}

function renderCanvasSlot(onActivateCanvasTerminal = vi.fn()): void {
  bodyEl.removeAttribute('data-tab-group-body-id')
  bodyEl.setAttribute('data-terminal-canvas-body-id', TAB_ID)
  const canvasCard = document.createElement('div')
  canvasCard.setAttribute('data-pane-canvas-terminal-id', TAB_ID)
  canvasViewport = document.createElement('div')
  canvasViewport.setAttribute('data-pane-canvas-viewport', 'true')
  canvasCard.appendChild(bodyEl)
  canvasViewport.appendChild(canvasCard)
  document.body.appendChild(canvasViewport)

  root = createRoot(container)
  act(() => {
    root.render(
      <TerminalOverlaySlot
        terminalTabId={TAB_ID}
        terminalGeneration={0}
        worktreeId="wt-1"
        worktreePath="wt-1"
        startupCwd={undefined}
        groupId={GROUP_ID}
        unifiedTabId="unified-1"
        canvasTerminalTabId={TAB_ID}
        isWorktreeActive
        isVisible
        isActive
        activityTerminalPortal={null}
        onFocusOwningGroup={vi.fn()}
        onActivateCanvasTerminal={onActivateCanvasTerminal}
        consumeSuppressedPtyExit={() => false}
        leaveWorktreeIfEmpty={vi.fn()}
      />
    )
  })
}

beforeEach(() => {
  terminalPaneRenderCount = 0
  terminalPaneProps = null
  markUnverifiedPtyLoss.mockReset()
  capturedResizeCallback = null
  capturedMutationCallback = null
  canvasViewport = null
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
  vi.stubGlobal('MutationObserver', CapturingMutationObserver)

  container = document.createElement('div')
  container.getBoundingClientRect = () => PARENT_RECT
  document.body.appendChild(container)

  bodyEl = document.createElement('div')
  bodyEl.setAttribute('data-tab-group-body-id', GROUP_ID)
  bodyRect = createRect({ top: 32, height: 568 })
  bodyEl.getBoundingClientRect = () => bodyRect
  document.body.appendChild(bodyEl)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  bodyEl?.remove()
  canvasViewport?.remove()
  vi.unstubAllGlobals()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
})

describe('TerminalPaneOverlayLayer fallback measure<->fit loop (React #185)', () => {
  it('keeps the tab when the host reports an unverified PTY loss', () => {
    renderSlot()

    act(() => {
      terminalPaneProps?.onPtyExit?.('pty-host-lost', -1)
    })

    expect(markUnverifiedPtyLoss).toHaveBeenCalledWith(TAB_ID)
  })

  it('does not re-render on ResizeObserver ticks with an unchanged rect', () => {
    renderSlot()
    expect(capturedResizeCallback).toBeTypeOf('function')

    const rendersAfterMount = terminalPaneRenderCount
    for (let i = 0; i < 50; i += 1) {
      act(() => {
        capturedResizeCallback?.()
      })
    }

    expect(terminalPaneRenderCount - rendersAfterMount).toBe(0)
  })

  it('settles sub-pixel jitter across an integer boundary without losing precision', () => {
    bodyRect = createRect({ top: 32.1, left: 0.1, width: 799.1, height: 567.1 })
    renderSlot()
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    expect(overlay?.style.top).toBe('32.1px')
    expect(overlay?.style.width).toBe('799.1px')

    const rendersAfterMount = terminalPaneRenderCount
    for (let i = 0; i < 50; i += 1) {
      bodyRect = createRect({ top: 32.9, left: 0.9, width: 799.9, height: 567.9 })
      act(() => {
        capturedResizeCallback?.()
      })
      bodyRect = createRect({ top: 32.1, left: 0.1, width: 799.1, height: 567.1 })
      act(() => {
        capturedResizeCallback?.()
      })
    }

    expect(terminalPaneRenderCount - rendersAfterMount).toBe(0)
    expect(overlay?.style.top).toBe('32.1px')
    expect(overlay?.style.width).toBe('799.1px')
  })

  it('commits a genuine geometry change', () => {
    renderSlot()
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    const rendersAfterMount = terminalPaneRenderCount

    bodyRect = createRect({ top: 34, width: 760, height: 566 })
    act(() => {
      capturedResizeCallback?.()
    })

    expect(terminalPaneRenderCount - rendersAfterMount).toBe(1)
    expect(overlay?.style.top).toBe('34px')
    expect(overlay?.style.width).toBe('760px')
  })

  it('tracks Canvas card movement in web clients where CSS anchors are unavailable', () => {
    bodyRect = createRect({ top: 80, left: 120, width: 560, height: 360 })
    renderCanvasSlot()
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    expect(overlay?.style.top).toBe('80px')
    expect(overlay?.style.left).toBe('120px')
    expect(capturedMutationCallback).toBeTypeOf('function')

    bodyRect = createRect({ top: 240, left: 360, width: 560, height: 360 })
    act(() => capturedMutationCallback?.())

    expect(overlay?.style.top).toBe('240px')
    expect(overlay?.style.left).toBe('360px')
  })

  it('contains wheel input that xterm releases with a non-passive native listener', () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    renderCanvasSlot()
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })

    act(() => {
      overlay?.dispatchEvent(wheel)
    })

    expect(wheel.defaultPrevented).toBe(true)
    expect(
      addEventListener.mock.calls.some(
        ([type, , options]) =>
          type === 'wheel' && typeof options === 'object' && options?.passive === false
      )
    ).toBe(true)
  })

  it('activates a Canvas terminal before xterm consumes its pointer event', () => {
    const activateCanvasTerminal = vi.fn()
    renderCanvasSlot(activateCanvasTerminal)
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const input = document.createElement('textarea')
    input.className = 'xterm-helper-textarea'
    xterm.appendChild(input)
    xterm.addEventListener('pointerdown', (event) => event.stopPropagation())
    overlay?.appendChild(xterm)

    act(() => {
      xterm.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })

    expect(activateCanvasTerminal).toHaveBeenCalledWith(TAB_ID, 'unified-1', GROUP_ID)
  })

  it('does not contain wheel input outside Canvas mode', () => {
    renderSlot()
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })

    act(() => {
      overlay?.dispatchEvent(wheel)
    })

    expect(wheel.defaultPrevented).toBe(false)
  })
})
