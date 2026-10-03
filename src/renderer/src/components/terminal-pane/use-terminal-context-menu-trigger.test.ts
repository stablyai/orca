// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { setHoveredTerminalFileLink } from './terminal-hovered-file-link'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { activeRuntimeEnvironmentId: null } }) }
}))

const CELL = 10

function mountPane(): { terminal: Terminal; container: HTMLDivElement; screen: HTMLElement } {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => new DOMRect(0, 0, 80 * CELL, 24 * CELL)
  element.append(screen)
  container.append(element)
  document.body.append(container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pointer hit-testing and the paste branch read only these fields.
  const terminal = {
    cols: 80,
    rows: 24,
    element,
    buffer: { active: { viewportY: 0 } },
    getSelection: () => ''
  } as unknown as Terminal
  return { terminal, container, screen }
}

type PaneTransport = { getPtyId: () => string; getConnectionId?: () => string }

function renderTrigger(options: { rightClickToPaste?: boolean; transport?: PaneTransport } = {}) {
  const pane = mountPane()
  const pasteResolvedPane = vi.fn().mockResolvedValue(undefined)
  const view = renderHook(() =>
    useTerminalContextMenuTrigger({
      managerRef: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger only lists panes.
        current: {
          getPanes: () => [{ id: 1, terminal: pane.terminal, container: pane.container }]
        } as unknown as PaneManager
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger only reads the pane owner off its transport.
      paneTransportsRef: {
        current: new Map(options.transport ? [[1, options.transport]] : [])
      } as unknown as Parameters<typeof useTerminalContextMenuTrigger>[0]['paneTransportsRef'],
      containerRef: { current: pane.container },
      contextPaneIdRef: { current: null },
      rightClickToPaste: options.rightClickToPaste ?? false,
      pasteResolvedPane
    })
  )
  return { ...pane, view, pasteResolvedPane }
}

/** A right-click on 1-based viewport cell (column, row) of the pane. */
function rightClick(
  target: HTMLElement,
  currentTarget: HTMLElement,
  column: number,
  row: number,
  ctrlKey = false
): React.MouseEvent<HTMLDivElement> {
  const clientX = (column - 1) * CELL + 1
  const clientY = (row - 1) * CELL + 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger reads only these event fields.
  return {
    target,
    currentTarget,
    clientX,
    clientY,
    ctrlKey,
    nativeEvent: { clientX, clientY },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as React.MouseEvent<HTMLDivElement>
}

const hoveredLink = {
  path: '/repo/src/foo.ts',
  range: { start: { x: 7, y: 3 }, end: { x: 16, y: 3 } },
  clientOsCanOpen: true
}

describe('useTerminalContextMenuTrigger', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('opens the menu with the file link under the right-click', () => {
    const { view, terminal, container, screen } = renderTrigger()
    setHoveredTerminalFileLink(terminal, hoveredLink)

    act(() => view.result.current.onContextMenuCapture(rightClick(screen, container, 8, 3)))

    expect(view.result.current.open).toBe(true)
    expect(view.result.current.fileLinkReveal).toEqual({ path: '/repo/src/foo.ts', blocked: false })
  })

  it('offers reveal as blocked for a link in a pane whose shell runs on an SSH host', () => {
    const { view, terminal, container, screen } = renderTrigger({
      transport: { getPtyId: () => 'pty-1', getConnectionId: () => 'ssh-1' }
    })
    setHoveredTerminalFileLink(terminal, hoveredLink)

    act(() => view.result.current.onContextMenuCapture(rightClick(screen, container, 8, 3)))

    expect(view.result.current.open).toBe(true)
    expect(view.result.current.fileLinkReveal).toEqual({ path: '/repo/src/foo.ts', blocked: true })
  })

  it('drops the link when the next menu is opened from the pane title', () => {
    const { view, terminal, container, screen } = renderTrigger()
    setHoveredTerminalFileLink(terminal, hoveredLink)
    act(() => view.result.current.onContextMenuCapture(rightClick(screen, container, 8, 3)))

    act(() => view.result.current.onPaneTitleContextMenu(rightClick(screen, container, 8, 3), 1))

    expect(view.result.current.fileLinkReveal).toBeNull()
  })

  it('keeps pasting on right-click over a link, and offers reveal on Ctrl+right-click', () => {
    const { view, terminal, container, screen, pasteResolvedPane } = renderTrigger({
      rightClickToPaste: true
    })
    setHoveredTerminalFileLink(terminal, hoveredLink)

    act(() => view.result.current.onContextMenuCapture(rightClick(screen, container, 8, 3)))
    expect(pasteResolvedPane).toHaveBeenCalledWith('right-click')
    expect(view.result.current.open).toBe(false)

    act(() => view.result.current.onContextMenuCapture(rightClick(screen, container, 8, 3, true)))
    expect(view.result.current.open).toBe(true)
    expect(view.result.current.fileLinkReveal).toEqual({ path: '/repo/src/foo.ts', blocked: false })
  })
})
