// @vitest-environment happy-dom
import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'

function createContextMenuEvent(
  currentTarget: HTMLDivElement,
  target: Node,
  ctrlKey = false
): React.MouseEvent<HTMLDivElement> {
  const nativeEvent = new MouseEvent('contextmenu', { clientX: 20, clientY: 30, ctrlKey })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook reads only this complete context-menu field subset.
  return {
    clientX: 20,
    clientY: 30,
    ctrlKey,
    currentTarget,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target
  } as unknown as React.MouseEvent<HTMLDivElement>
}

function createManager(container: HTMLDivElement): PaneManager {
  const pane = {
    container,
    id: 7,
    terminal: { getSelection: () => '' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook only calls getPanes and reads the pane fields above.
  return { getPanes: () => [pane] } as unknown as PaneManager
}

const capturedFilePath = (): Promise<string> => Promise.resolve('/repo/src/app.ts')

describe('useTerminalContextMenuTrigger reveal target capture', () => {
  it('clears a previous terminal file when the next menu opens from a pane title', () => {
    const bounds = document.createElement('div')
    const paneContainer = document.createElement('div')
    const target = document.createTextNode('terminal')
    paneContainer.append(target)
    bounds.append(paneContainer)
    const manager = createManager(paneContainer)
    const resolver = vi.fn(() => capturedFilePath)
    const result = renderHook(() =>
      useTerminalContextMenuTrigger({
        managerRef: { current: manager },
        containerRef: { current: bounds },
        contextPaneIdRef: { current: null },
        resolveContextMenuFileLinkRef: { current: resolver },
        rightClickToPaste: false,
        pasteResolvedPane: vi.fn()
      })
    )

    act(() => {
      result.result.current.onContextMenuCapture(createContextMenuEvent(bounds, target))
    })
    expect(result.result.current.contextMenuFilePathRef.current).toBe(capturedFilePath)
    expect(resolver).toHaveBeenCalledWith(7, expect.any(MouseEvent))

    act(() => {
      result.result.current.onPaneTitleContextMenu(createContextMenuEvent(bounds, bounds), 7)
    })
    expect(result.result.current.contextMenuFilePathRef.current).toBeNull()
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('captures only when Ctrl opens the app menu for right-click-to-paste users', () => {
    const bounds = document.createElement('div')
    const paneContainer = document.createElement('div')
    const target = document.createTextNode('terminal')
    paneContainer.append(target)
    bounds.append(paneContainer)
    const resolver = vi.fn(() => capturedFilePath)
    const result = renderHook(() =>
      useTerminalContextMenuTrigger({
        managerRef: { current: createManager(paneContainer) },
        containerRef: { current: bounds },
        contextPaneIdRef: { current: null },
        resolveContextMenuFileLinkRef: { current: resolver },
        rightClickToPaste: true,
        pasteResolvedPane: vi.fn()
      })
    )

    act(() => {
      result.result.current.onContextMenuCapture(createContextMenuEvent(bounds, target))
    })
    expect(resolver).not.toHaveBeenCalled()

    act(() => {
      result.result.current.onContextMenuCapture(createContextMenuEvent(bounds, target, true))
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(result.result.current.contextMenuFilePathRef.current).toBe(capturedFilePath)

    act(() => {
      result.result.current.onContextMenuCapture(createContextMenuEvent(bounds, target))
    })
    expect(result.result.current.contextMenuFilePathRef.current).toBeNull()
  })
})
