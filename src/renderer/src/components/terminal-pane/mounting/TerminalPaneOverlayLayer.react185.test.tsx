/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let terminalPaneProps: { onPtyExit?: (ptyId: string, exitCode?: number) => void } | null = null
const markUnverifiedPtyLoss = vi.fn()
vi.mock('../TerminalPane', () => ({
  default: (props: { onPtyExit?: (ptyId: string, exitCode?: number) => void }) => {
    terminalPaneProps = props
    return null
  }
}))

vi.mock('../../../store/index', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ pendingStartupByTabId: {}, markUnverifiedPtyLoss })
  })
}))

import { TerminalOverlaySlot } from './TerminalOverlaySlot'
import { registerTabGroupBody } from '../../tab-group/tab-group-body-geometry'

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

let container: HTMLDivElement
let bodyEl: HTMLDivElement
let bodyRect: DOMRect
let unregisterBody: () => void
let root: Root

class StubResizeObserver {
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
        captureEmptiedReaction={() => vi.fn()}
      />
    )
  })
}

beforeEach(() => {
  terminalPaneProps = null
  markUnverifiedPtyLoss.mockReset()
  Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
  vi.stubGlobal('ResizeObserver', StubResizeObserver)

  container = document.createElement('div')
  container.getBoundingClientRect = () => PARENT_RECT
  document.body.appendChild(container)

  bodyEl = document.createElement('div')
  bodyEl.setAttribute('data-tab-group-body-id', GROUP_ID)
  bodyRect = createRect({ top: 32, height: 568 })
  bodyEl.getBoundingClientRect = () => bodyRect
  document.body.appendChild(bodyEl)
  unregisterBody = registerTabGroupBody(GROUP_ID, bodyEl)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  unregisterBody()
  container?.remove()
  bodyEl?.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
})

describe('TerminalPaneOverlayLayer fallback measure<->fit loop (React #185)', () => {
  it('keeps the tab when the host reports an unverified PTY loss', () => {
    renderSlot()

    act(() => {
      terminalPaneProps?.onPtyExit?.('pty-host-lost', -1)
    })

    expect(markUnverifiedPtyLoss).toHaveBeenCalledWith(TAB_ID)
  })
})
