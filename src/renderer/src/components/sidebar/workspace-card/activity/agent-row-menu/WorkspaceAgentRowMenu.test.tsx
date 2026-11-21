// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { AgentRowMenuContent, useWorkspaceAgentRowMenu } from './WorkspaceAgentRowMenu'

const onOpen = vi.fn()

function Row(props: {
  unread?: boolean
  canToggleRead?: boolean
  canMarkUnread?: boolean
}): React.JSX.Element {
  const menu = useWorkspaceAgentRowMenu()
  return (
    <div data-testid="row" className="relative" {...menu.rowProps}>
      Chat
      <button type="button" data-testid="row-control">
        x
      </button>
      {menu.menu ? (
        <AgentRowMenuContent
          menu={menu.menu}
          onClose={menu.close}
          title="Chat"
          unread={props.unread ?? false}
          canToggleRead={props.canToggleRead ?? true}
          canMarkUnread={props.canMarkUnread ?? true}
          paneKey="tab:pane"
          onOpen={onOpen}
        />
      ) : null}
    </div>
  )
}

function labels(): string[] {
  return Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )
}

function item(label: string): HTMLElement {
  const found = screen.getAllByRole('menuitem').find((entry) => entry.textContent === label)
  if (!found) {
    throw new Error(`no ${label}`)
  }
  return found
}

afterEach(() => {
  cleanup()
  onOpen.mockReset()
  vi.useRealTimers()
})

describe('WorkspaceAgentRowMenu', () => {
  it('offers only the agent actions, under an Agent label', () => {
    render(<Row unread />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    expect(screen.getByText('Agent')).toBeTruthy()
    expect(labels()).toEqual(['Open', 'Copy Title', 'Mark Read'])
    expect(screen.getByTestId('row').getAttribute('data-agent-row-menu-open')).toBe('true')
  })

  it('keeps Mark Unread visible but disabled on the agent being viewed', () => {
    render(<Row canMarkUnread={false} />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    expect(item('Mark Unread').hasAttribute('data-disabled')).toBe(true)
  })

  it('disables the read toggle on a row with no read state of its own', () => {
    render(<Row unread={false} canToggleRead={false} />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    expect(item('Mark Unread').hasAttribute('data-disabled')).toBe(true)
  })

  it('ignores the release of the right-click that opened it, then acts on a real click', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(<Row />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    const open = item('Open')
    fireEvent.pointerUp(open, { button: 2 })
    fireEvent.click(open)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
    vi.setSystemTime(1_792_983_601_000)
    fireEvent.click(item('Open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens from the keyboard under the row and gives focus back on close', async () => {
    render(<Row />)
    const control = screen.getByTestId('row-control')
    control.focus()
    // A context-menu key press reports no pointer position.
    fireEvent.contextMenu(control, { clientX: 0, clientY: 0 })
    const anchor = screen.getByTestId('row').querySelector('button[aria-hidden]')
    expect(anchor?.getAttribute('style')).toContain('left: 8px')
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    expect(screen.queryByRole('menu')).toBeNull()
    // The menu hands focus back on the tick after it unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(control)
  })

  it('closes when another menu asks every menu to close', () => {
    render(<Row />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTestId('row').hasAttribute('data-agent-row-menu-open')).toBe(false)
  })
})
