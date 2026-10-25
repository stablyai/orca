/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type PaneProps = { onCloseTab?: () => void; onPtyExit?: (ptyId: string, exitCode?: number) => void }
let paneProps: PaneProps | null = null
vi.mock('./TerminalPane', () => ({
  default: (props: PaneProps) => {
    paneProps = props
    return null
  }
}))

const mocks = vi.hoisted(() => ({
  deferParked: false,
  markUnverifiedPtyLoss: vi.fn(),
  closeTerminalTab: vi.fn((_tabId: string, options?: { onClosed?: () => void }) =>
    options?.onClosed?.()
  )
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({
      pendingStartupByTabId: {},
      markUnverifiedPtyLoss: mocks.markUnverifiedPtyLoss
    })
  })
}))
vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))
vi.mock('./terminal-parked-tab-watchers', () => ({
  shouldDeferParkedPtyExitTabClose: () => mocks.deferParked
}))

import { TerminalOverlaySlot } from './TerminalOverlaySlot'

let root: Root
let container: HTMLDivElement
const capture = vi.fn((..._args: unknown[]) => () => {})

function renderSlot(suppressed = false): void {
  root = createRoot(container)
  act(() => {
    root.render(
      <TerminalOverlaySlot
        terminalTabId="term-1"
        terminalGeneration={0}
        worktreeId="wt-1"
        worktreePath="/wt"
        startupCwd={undefined}
        groupId="g1"
        isWorktreeActive
        isVisible
        isActive
        activityTerminalPortal={null}
        onFocusOwningGroup={vi.fn()}
        consumeSuppressedPtyExit={() => suppressed}
        captureEmptiedReaction={capture}
      />
    )
  })
}

describe('terminal slot auto-delete trigger class', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    capture.mockClear()
    mocks.deferParked = false
  })
  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('reports a pane close as a user close', () => {
    renderSlot()
    act(() => paneProps?.onCloseTab?.())
    expect(capture).toHaveBeenCalledWith('close', 'term-1')
  })

  it('reports a proven process exit as an exit', () => {
    renderSlot()
    act(() => paneProps?.onPtyExit?.('pty-1', 0))
    expect(capture).toHaveBeenCalledWith('exit', 'term-1')
  })

  it('closes a code-less exit without an auto-delete trigger', () => {
    renderSlot()
    act(() => paneProps?.onPtyExit?.('pty-1'))
    expect(capture).toHaveBeenCalledWith(null, 'term-1')
  })

  it('captures nothing for suppressed, unproven or parked-deferred exits', () => {
    renderSlot(true)
    act(() => paneProps?.onPtyExit?.('pty-1', 0))
    act(() => root.unmount())
    renderSlot()
    act(() => paneProps?.onPtyExit?.('pty-1', -1))
    mocks.deferParked = true
    act(() => paneProps?.onPtyExit?.('pty-1', 0))
    expect(capture).not.toHaveBeenCalled()
  })
})
