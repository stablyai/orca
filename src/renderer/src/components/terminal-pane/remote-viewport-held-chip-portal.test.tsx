// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { TerminalPaneMobileDriverPortals } from './TerminalPaneRuntimePortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const PTY_ID = 'held-pty'
let root: Root | null = null

function renderPortals(
  overrides: Partial<{ searchOpen: boolean; chatView: boolean; paneGrid: object | undefined }> = {}
) {
  const container = document.createElement('div')
  const host = document.createElement('div')
  document.body.append(container, host)
  const claimViewport = vi.fn(() => true)
  const focus = vi.fn()
  const pane = {
    id: 1,
    leafId: 'leaf-1',
    container,
    terminal: { focus },
    fitAddon: {
      proposeDimensions: () =>
        'paneGrid' in overrides ? overrides.paneGrid : { cols: 120, rows: 40 }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portal reads only these controller fields and these pane members.
  const controller = {
    activePane: pane,
    chatLeafId: 'leaf-1',
    effectiveChatViewMode: overrides.chatView ?? false,
    managedPanes: [pane],
    paneTransportsRef: { current: new Map([[1, { getPtyId: () => PTY_ID, claimViewport }]]) },
    restoreAllTerminalFits: vi.fn(),
    restorePaneTerminalFit: vi.fn(),
    searchOpen: overrides.searchOpen ?? false
  } as unknown as TerminalPaneController
  root = createRoot(host)
  act(() => root?.render(<TerminalPaneMobileDriverPortals controller={controller} />))
  const fitHere = (): HTMLButtonElement | null =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Fit here') ??
    null
  return { fitHere, claimViewport, focus }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
})

describe('remote viewport held chip in terminal panes', () => {
  it('offers Fit here while another window holds the pane at a different grid', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    const { fitHere, claimViewport, focus } = renderPortals()

    act(() => fitHere()!.click())

    expect(claimViewport).toHaveBeenCalledWith(120, 40)
    expect(focus).toHaveBeenCalled()
  })

  it('stays hidden when this window owns the size or nothing holds it', () => {
    expect(renderPortals().fitHere()).toBeNull()
    act(() => root?.unmount())
    setFitOverride(PTY_ID, 'desktop-fit', 120, 40)
    expect(renderPortals().fitHere()).toBeNull()
  })

  it('stays hidden when the held grid already matches, the pane is unmeasurable, or chat owns it', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 120, 40)
    expect(renderPortals().fitHere()).toBeNull()
    act(() => root?.unmount())

    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    expect(renderPortals({ paneGrid: undefined }).fitHere()).toBeNull()
    act(() => root?.unmount())
    expect(renderPortals({ chatView: true }).fitHere()).toBeNull()
  })

  it('yields the corner to an open find bar on the active pane', () => {
    setFitOverride(PTY_ID, 'remote-desktop-fit', 200, 50)
    expect(renderPortals({ searchOpen: true }).fitHere()).toBeNull()
  })
})
