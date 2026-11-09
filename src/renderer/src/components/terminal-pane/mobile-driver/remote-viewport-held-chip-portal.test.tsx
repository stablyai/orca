// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { TerminalPaneMobileDriverPortals } from './TerminalPaneMobileDriverPortals'
import type { TerminalPaneController } from '../controller/use-terminal-pane-controller'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const PTY_ID = 'held-pty'
let root: Root | null = null
const resizeCallbacks: (() => void)[] = []

class ResizeObserverStub {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    resizeCallbacks.push(this.callback)
  }
  disconnect(): void {
    resizeCallbacks.splice(resizeCallbacks.indexOf(this.callback), 1)
  }
}

type Grid = { cols: number; rows: number }

function renderPortals(
  options: Partial<{ searchOpen: boolean; chatView: boolean; activePaneId: number }> = {}
) {
  const container = document.createElement('div')
  const host = document.createElement('div')
  document.body.append(container, host)
  const claimViewport = vi.fn(() => true)
  const focus = vi.fn()
  const measured: { grid: Grid | undefined } = { grid: { cols: 120, rows: 40 } }
  const pane = {
    id: 1,
    leafId: 'leaf-1',
    container,
    terminal: { focus },
    fitAddon: { proposeDimensions: () => measured.grid }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portal reads only these controller fields and these pane members.
  const controller = {
    activePane: { id: options.activePaneId ?? pane.id },
    chatLeafId: 'leaf-1',
    effectiveChatViewMode: options.chatView ?? false,
    managedPanes: [pane],
    paneTransportsRef: { current: new Map([[1, { getPtyId: () => PTY_ID, claimViewport }]]) },
    restoreAllTerminalFits: vi.fn(),
    restorePaneTerminalFit: vi.fn(),
    searchOpen: options.searchOpen ?? false
  } as unknown as TerminalPaneController
  root = createRoot(host)
  act(() =>
    root?.render(
      <TooltipProvider>
        <TerminalPaneMobileDriverPortals controller={controller} />
      </TooltipProvider>
    )
  )
  const fitHere = (): HTMLButtonElement | null =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Fit here') ??
    null
  const resizePane = (grid: Grid | undefined): void => {
    measured.grid = grid
    act(() => resizeCallbacks.forEach((callback) => callback()))
  }
  return { container, fitHere, resizePane, claimViewport, focus }
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
  setDriverForPty(PTY_ID, { kind: 'idle' })
})

describe('remote viewport held chip in terminal panes', () => {
  it('offers Fit here while another window holds the pane at a different grid', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    const { fitHere, claimViewport, focus } = renderPortals()

    act(() => fitHere()!.click())

    expect(claimViewport).toHaveBeenCalledWith(120, 40)
    expect(focus).toHaveBeenCalled()
  })

  it('stays hidden when no other window holds the size', () => {
    expect(renderPortals().fitHere()).toBeNull()
  })

  it('appears once a hidden pane gets a size, and clears once its grid matches the held one', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    const { fitHere, resizePane } = renderPortals()
    resizePane(undefined)
    expect(fitHere()).toBeNull()

    resizePane({ cols: 120, rows: 40 })
    expect(fitHere()).not.toBeNull()

    resizePane({ cols: 200, rows: 50 })
    expect(fitHere()).toBeNull()
  })

  it('stays hidden on the chat surface', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    expect(renderPortals({ chatView: true }).fitHere()).toBeNull()
  })

  it('gives way to the phone banner while a phone drives', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    setDriverForPty(PTY_ID, { kind: 'mobile', clientId: 'phone' })
    const { container, fitHere } = renderPortals()
    expect(fitHere()).toBeNull()
    expect(container.textContent).toContain('Take back')
  })

  it('yields the corner only to a find bar open on the same pane', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    expect(renderPortals({ searchOpen: true }).fitHere()).toBeNull()
    unmount()
    expect(renderPortals({ searchOpen: true, activePaneId: 2 }).fitHere()).not.toBeNull()
  })
})
