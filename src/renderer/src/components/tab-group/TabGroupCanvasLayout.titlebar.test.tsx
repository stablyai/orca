// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneCanvasWorkspaceState } from './pane-canvas-layout-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

import TabGroupCanvasLayout from './TabGroupCanvasLayout'

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

describe('TabGroupCanvasLayout titlebar', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const canvasState: PaneCanvasWorkspaceState = {
      mode: 'canvas',
      boundsByTerminalTabId: {}
    }
    await act(async () => {
      root.render(
        <TabGroupCanvasLayout
          terminalItems={[]}
          canvasState={canvasState}
          updateCanvasState={vi.fn()}
          onVisibleTerminalTabIdsChange={vi.fn()}
          allowTerminalCreation={false}
          toolbarContent={<button type="button">Scope</button>}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps unused header space draggable and only marks controls no-drag', () => {
    const toolbar = container.querySelector('[data-pane-canvas-toolbar]') as HTMLElement
    const controls = container.querySelector('[data-pane-canvas-toolbar-controls]') as HTMLElement
    const splits = container.querySelector('button') as HTMLButtonElement

    expect(toolbar.dataset.terminalFocusReleaseSurface).toBe('true')
    expect(toolbar.classList.contains('pane-canvas-toolbar-window-controls-inset')).toBe(true)
    expect(toolbar.dataset.paneCanvasToolbarControls).toBeUndefined()
    expect(controls.dataset.paneCanvasToolbarControls).toBe('true')
    expect(controls.classList.contains('ml-auto')).toBe(true)
    expect(splits.getAttribute('aria-label')).toBe('Splits')
    expect(splits.dataset.paneCanvasToolbarControl).toBe('true')
  })

  it('omits the window-control inset when another surface owns the right edge', async () => {
    const canvasState: PaneCanvasWorkspaceState = {
      mode: 'canvas',
      boundsByTerminalTabId: {}
    }
    await act(async () => {
      root.render(
        <TabGroupCanvasLayout
          terminalItems={[]}
          canvasState={canvasState}
          updateCanvasState={vi.fn()}
          onVisibleTerminalTabIdsChange={vi.fn()}
          allowTerminalCreation={false}
          trailingChromeInset="none"
        />
      )
    })

    const toolbar = container.querySelector('[data-pane-canvas-toolbar]') as HTMLElement
    expect(toolbar.classList.contains('pane-canvas-toolbar-window-controls-inset')).toBe(false)
  })

  it('contains browser zoom gestures without blocking ordinary canvas scrolling', () => {
    const viewport = container.querySelector('[data-pane-canvas-viewport]') as HTMLElement
    const zoomWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    })
    // happy-dom does not currently copy ctrlKey from WheelEventInit.
    Object.defineProperty(zoomWheel, 'ctrlKey', { value: true })
    const scrollWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    })

    viewport.dispatchEvent(zoomWheel)
    viewport.dispatchEvent(scrollWheel)

    expect(zoomWheel.defaultPrevented).toBe(true)
    expect(scrollWheel.defaultPrevented).toBe(false)
  })
})
