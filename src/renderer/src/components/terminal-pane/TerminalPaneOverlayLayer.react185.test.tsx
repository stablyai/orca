/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let terminalPaneRenderCount = 0
vi.mock('./TerminalPane', () => ({
  default: () => {
    terminalPaneRenderCount += 1
    return null
  }
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ pendingStartupByTabId: {} })
  })
}))

import { TerminalOverlaySlot } from './TerminalPaneOverlayLayer'

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
let container: HTMLDivElement
let bodyEl: HTMLDivElement
let bodyRect: DOMRect
let root: Root

class CapturingResizeObserver {
  constructor(cb: () => void) {
    capturedResizeCallback = cb
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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

beforeEach(() => {
  terminalPaneRenderCount = 0
  capturedResizeCallback = null
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver)

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
  vi.unstubAllGlobals()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
})

describe('TerminalPaneOverlayLayer fallback measure<->fit loop (React #185)', () => {
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
})
