// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

const findHttpLinkAtTerminalPointer = vi.hoisted(() =>
  vi.fn<() => string | null>(() => 'https://example.com/')
)
vi.mock('./terminal-url-link-hit-testing', () => ({ findHttpLinkAtTerminalPointer }))
// The right-clicked cell: column 5 of buffer row 2.
vi.mock('./terminal-mouse-buffer-position', () => ({
  getTerminalBufferPositionForMouseEvent: () => ({ x: 5, y: 2 })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'
import { setHoveredTerminalOscLink } from './terminal-osc-link-hover'

function renderTrigger(rightClickToPaste: boolean) {
  const container = document.createElement('div')
  const cell = document.createElement('span')
  container.appendChild(cell)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger reads only the pane id, container, and selection.
  const pane = {
    id: 1,
    container,
    terminal: { getSelection: () => '' }
  } as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger only lists panes.
  const manager = { getPanes: () => [pane] } as unknown as PaneManager
  const pasteResolvedPane = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useTerminalContextMenuTrigger({
      managerRef: { current: manager },
      containerRef: { current: container },
      contextPaneIdRef: { current: null },
      paneTransportsRef: { current: new Map() },
      canOpenOwnedBrowserForPaneRef: { current: () => false },
      worktreeId: 'wt-1',
      rightClickToPaste,
      pasteResolvedPane
    })
  )
  const rightClick = (): void =>
    act(() =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trigger reads only these event members.
      result.current.onContextMenuCapture({
        target: cell,
        currentTarget: container,
        nativeEvent: new MouseEvent('contextmenu'),
        clientX: 10,
        clientY: 10,
        ctrlKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.MouseEvent<HTMLDivElement>)
    )
  return { result, rightClick, pasteResolvedPane, pane }
}

afterEach(() => {
  findHttpLinkAtTerminalPointer.mockReset()
})

describe('useTerminalContextMenuTrigger link targets', () => {
  it('captures the URL under the pointer when the menu opens', () => {
    findHttpLinkAtTerminalPointer.mockReturnValue('https://example.com/')
    const { result, rightClick } = renderTrigger(false)

    rightClick()

    expect(result.current.open).toBe(true)
    expect(result.current.linkTarget).toEqual({
      url: 'https://example.com/',
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      canOpenOwnedBrowser: false
    })
  })

  it('opens without a link target off a link', () => {
    findHttpLinkAtTerminalPointer.mockReturnValue(null)
    const { result, rightClick } = renderTrigger(false)

    rightClick()

    expect(result.current.open).toBe(true)
    expect(result.current.linkTarget).toBeNull()
  })

  it('captures the hovered OSC 8 http(s) link under the pointer, whose URI the text scan cannot see', () => {
    findHttpLinkAtTerminalPointer.mockReturnValue(null)
    const { result, rightClick, pane } = renderTrigger(false)
    const onRow = (y: number) => ({ start: { x: 1, y }, end: { x: 10, y } })

    setHoveredTerminalOscLink(pane.terminal, { uri: 'file:///tmp/notes.txt', range: onRow(2) })
    rightClick()
    expect(result.current.linkTarget).toBeNull()

    setHoveredTerminalOscLink(pane.terminal, { uri: 'https://docs.example.com/', range: onRow(3) })
    rightClick()
    expect(result.current.linkTarget).toBeNull()

    setHoveredTerminalOscLink(pane.terminal, { uri: 'https://docs.example.com/', range: onRow(2) })
    rightClick()
    expect(result.current.linkTarget?.url).toBe('https://docs.example.com/')
  })

  it('still pastes without a menu when right-click-to-paste is on over a URL', () => {
    findHttpLinkAtTerminalPointer.mockReturnValue('https://example.com/')
    const { result, rightClick, pasteResolvedPane } = renderTrigger(true)

    rightClick()

    expect(pasteResolvedPane).toHaveBeenCalledWith('right-click')
    expect(result.current.open).toBe(false)
    expect(result.current.linkTarget).toBeNull()
  })
})
