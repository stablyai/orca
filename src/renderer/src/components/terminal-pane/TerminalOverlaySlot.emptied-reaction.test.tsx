/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  clearFloatingPanelReclaimIntent,
  consumeFloatingPanelReclaimIntent
} from '@/lib/floating-workspace-focus-reclaim'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type PaneProps = { onCloseTab?: () => void; onPtyExit?: (ptyId: string, exitCode?: number) => void }
let paneProps: PaneProps | null = null
vi.mock('./TerminalPane', () => ({
  default: (props: PaneProps) => {
    paneProps = props
    return null
  }
}))

const panel = vi.hoisted(() => ({ focused: false, remaining: 0 }))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ pendingStartupByTabId: {} })
  })
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => panel.focused
}))
vi.mock('@/store/selectors', () => ({ selectFloatingVisibleTabCount: () => panel.remaining }))

// Why the close blurs before it lands: removing the focused pane drops focus to the body.
const closeTerminalTab = vi.hoisted(() =>
  vi.fn((_tabId: string, options?: { onClosed?: () => void }) => {
    panel.focused = false
    options?.onClosed?.()
  })
)
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab }))
vi.mock('./terminal-parked-tab-watchers', () => ({
  shouldDeferParkedPtyExitTabClose: () => false
}))

import { TerminalOverlaySlot } from './TerminalOverlaySlot'
import { captureWorkspaceEmptiedReaction } from '../tab-group/workspace-emptied-reaction'

let root: Root
let container: HTMLDivElement

function renderFloatingSlot(): void {
  root = createRoot(container)
  act(() => {
    root.render(
      <TerminalOverlaySlot
        terminalTabId="floating-terminal"
        terminalGeneration={0}
        worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
        worktreePath="/floating"
        startupCwd={undefined}
        groupId="floating-group"
        isWorktreeActive
        isVisible
        isActive
        activityTerminalPortal={null}
        onFocusOwningGroup={vi.fn()}
        consumeSuppressedPtyExit={() => false}
        captureEmptiedReaction={() =>
          captureWorkspaceEmptiedReaction(FLOATING_TERMINAL_WORKTREE_ID)
        }
      />
    )
  })
}

// Closing the last floating pane from inside the panel keeps keyboard ownership for the next
// Cmd/Ctrl+T — the same as closing its tab.
describe('closing the last floating terminal pane', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    clearFloatingPanelReclaimIntent()
    closeTerminalTab.mockClear()
    panel.focused = true
    panel.remaining = 0
  })
  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('keeps the panel focus when the pane closes itself from inside the panel', () => {
    renderFloatingSlot()

    act(() => paneProps?.onCloseTab?.())

    expect(consumeFloatingPanelReclaimIntent()).toBe(true)
  })

  it('keeps the panel focus when the last shell exits inside the panel', () => {
    renderFloatingSlot()

    act(() => paneProps?.onPtyExit?.('pty-1', 0))

    expect(consumeFloatingPanelReclaimIntent()).toBe(true)
  })

  it('leaves focus alone when the pane closes while the panel does not own the keyboard', () => {
    panel.focused = false
    renderFloatingSlot()

    act(() => paneProps?.onCloseTab?.())

    expect(consumeFloatingPanelReclaimIntent()).toBe(false)
  })
})
