// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalContextMenu from './TerminalContextMenu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function flushMacrotask(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function MenuHarness(props: {
  menuOpenedAtRef: React.RefObject<number>
  onRestoreTerminalFocus: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button type="button" data-testid="outside">
        Outside
      </button>
      <TerminalContextMenu
        open={open}
        onOpenChange={setOpen}
        onRestoreTerminalFocus={props.onRestoreTerminalFocus}
        menuPoint={{ x: 20, y: 20 }}
        menuOpenedAtRef={props.menuOpenedAtRef}
        canClosePane={false}
        closePaneLabel="Close Pane"
        canExpandPane={false}
        menuPaneIsExpanded={false}
        onCopy={() => {}}
        addToChat={null}
        onSelectAll={() => {}}
        onPaste={() => {}}
        onSplitRight={() => {}}
        onSplitDown={() => {}}
        keybindings={{}}
        canEqualizePaneSizes={false}
        onEqualizePaneSizes={() => {}}
        onClosePane={() => {}}
        onClearScreen={() => {}}
        onResetTerminal={() => {}}
        canContinueAgentSessionInNewSession={false}
        onContinueAgentSessionInNewSession={() => {}}
        onForkAgentSession={() => {}}
        canToggleNativeChat={false}
        isNativeChatView={false}
        onToggleNativeChat={() => {}}
        onCopyAgentSessionContext={() => {}}
        quickCommandHosts={[]}
        quickCommandHostLoadFailed={false}
        quickCommandHostOwnershipPending={false}
        quickCommandRepoLabel={null}
        onQuickCommand={() => {}}
        onAddQuickCommand={() => {}}
        onToggleExpand={() => {}}
        onSetTitle={() => {}}
        onClearPaneTitle={() => {}}
        canClearPaneTitle={false}
        onCopyTerminalId={() => {}}
        onCopyPaneId={() => {}}
        canCopyAgentSessionId={false}
        onCopyAgentSessionId={() => {}}
      />
    </div>
  )
}

describe('TerminalContextMenu focus restoration', () => {
  it('restores terminal focus when dismissed with Escape', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const onRestoreTerminalFocus = vi.fn()
    render(
      <MenuHarness
        menuOpenedAtRef={{ current: 1_000 }}
        onRestoreTerminalFocus={onRestoreTerminalFocus}
      />
    )
    await flushMacrotask()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
      expect(onRestoreTerminalFocus).toHaveBeenCalledOnce()
    })
  })

  it('skips terminal focus restoration when dismissed by an outside pointer down', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const onRestoreTerminalFocus = vi.fn()
    render(
      <MenuHarness
        menuOpenedAtRef={{ current: 1_000 }}
        onRestoreTerminalFocus={onRestoreTerminalFocus}
      />
    )
    await flushMacrotask()

    fireEvent.pointerDown(screen.getByTestId('outside'), { button: 0, ctrlKey: false })

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    await flushMacrotask()
    expect(onRestoreTerminalFocus).not.toHaveBeenCalled()
  })
})
