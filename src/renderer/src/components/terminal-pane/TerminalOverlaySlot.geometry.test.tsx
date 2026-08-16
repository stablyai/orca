/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./TerminalPane', () => ({
  default: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ pendingStartupByTabId: {} })
  })
}))

import { TerminalOverlaySlot } from './TerminalOverlaySlot'

const GROUP_ID = 'group-snap-geometry'
const TAB_ID = 'tab-snap-geometry'

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

let container: HTMLDivElement
let bodyEl: HTMLDivElement
let bodyRect: DOMRect
let overlayRect: DOMRect
let root: Root
let resizeCallback: (() => void) | null

class CapturingResizeObserver {
  constructor(cb: () => void) {
    resizeCallback = cb
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function renderSlot(): HTMLElement {
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
  const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
  if (!overlay) {
    throw new Error('overlay not mounted')
  }
  return overlay
}

beforeEach(() => {
  resizeCallback = null
  // Why: exercise the Electron CSS-anchor path so we can prove post-snap
  // desync recovery switches to measured geometry (web client always measures).
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  const supports = (property: string, value: string): boolean => {
    if (property === 'position-anchor') {
      return true
    }
    if (property === 'top' && value.startsWith('anchor(')) {
      return true
    }
    if (property === 'width' && value.startsWith('anchor-size(')) {
      return true
    }
    return false
  }
  vi.stubGlobal('CSS', { supports })
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver)

  container = document.createElement('div')
  container.getBoundingClientRect = () => createRect({ width: 1000, height: 800 })
  document.body.appendChild(container)

  bodyEl = document.createElement('div')
  bodyEl.setAttribute('data-tab-group-body-id', GROUP_ID)
  bodyEl.setAttribute('data-worktree-id', 'wt-1')
  bodyRect = createRect({ top: 36, left: 500, width: 500, height: 764 })
  bodyEl.getBoundingClientRect = () => bodyRect
  document.body.appendChild(bodyEl)

  // Why: simulate Chromium leaving the overlay on the pre-snap full-area box
  // while the body is only the right half after a side-by-side snap.
  overlayRect = createRect({ top: 0, left: 0, width: 1000, height: 800 })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  bodyEl?.remove()
  vi.unstubAllGlobals()
})

describe('TerminalOverlaySlot geometry after pane-column snap', () => {
  it('falls back to measured geometry when CSS-anchor hit-test desyncs from the body', () => {
    const overlay = renderSlot()
    overlay.getBoundingClientRect = () => overlayRect

    act(() => {
      resizeCallback?.()
    })

    expect(overlay.dataset.overlayGeometry).toBe('measured')
    expect(overlay.style.top).toBe('36px')
    expect(overlay.style.left).toBe('500px')
    expect(overlay.style.width).toBe('500px')
    expect(overlay.style.height).toBe('764px')
  })

  it('does not permanently latch measured geometry while the slot is hidden', () => {
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
          isVisible={false}
          isActive={false}
          activityTerminalPortal={null}
          onFocusOwningGroup={vi.fn()}
          consumeSuppressedPtyExit={() => false}
          leaveWorktreeIfEmpty={vi.fn()}
        />
      )
    })
    const overlay = container.querySelector<HTMLElement>('[data-terminal-overlay-tab-id]')
    expect(overlay).not.toBeNull()
    if (!overlay) {
      throw new Error('overlay not mounted')
    }
    overlay.getBoundingClientRect = () => createRect({ width: 0, height: 0 })

    act(() => {
      resizeCallback?.()
    })

    // Why: hidden slots stay on the CSS-anchor path so a later reveal can still
    // detect a real post-snap desync instead of inheriting a false latch.
    expect(overlay.dataset.overlayGeometry).toBe('anchor')
  })
})
