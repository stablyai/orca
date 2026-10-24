// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'

type MenuState = ReturnType<typeof useTerminalPaneContextMenu>

const mountedRoots: Root[] = []

function renderMenuHook(paneCount: number): {
  menu: () => MenuState
  onRequestClosePane: ReturnType<typeof vi.fn>
} {
  const panes = Array.from({ length: paneCount }, (_, index) => ({ id: index + 1 }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The close action only reads pane ids from the manager.
  const manager = {
    getPanes: () => panes,
    getActivePane: () => panes[0]
  } as unknown as PaneManager
  const onRequestClosePane = vi.fn()
  let latest: MenuState | null = null

  function Harness(): null {
    latest = useTerminalPaneContextMenu({
      managerRef: { current: manager },
      paneTransportsRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      containerRef: { current: null },
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      groupId: null,
      fallbackCwd: '/tmp',
      toggleExpandPane: vi.fn(),
      onRequestClosePane,
      onClearPaneScrollback: (_pane: ManagedPane) => {},
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      onPasteError: vi.fn(),
      onAgentSessionForkReady: vi.fn(),
      onAgentSessionContinuationReady: vi.fn(),
      forceBracketedMultilineTextPaste: false,
      rightClickToPaste: false
    })
    return null
  }

  const root = createRoot(document.createElement('div'))
  mountedRoots.push(root)
  act(() => root.render(<Harness />))
  return {
    menu: () => {
      if (!latest) {
        throw new Error('hook did not render')
      }
      return latest
    },
    onRequestClosePane
  }
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
})

describe('useTerminalPaneContextMenu onClosePane', () => {
  it('routes a single-pane close through the shared close request (tab close path)', () => {
    const { menu, onRequestClosePane } = renderMenuHook(1)
    menu().onClosePane()
    expect(onRequestClosePane).toHaveBeenCalledWith(1)
  })
})
