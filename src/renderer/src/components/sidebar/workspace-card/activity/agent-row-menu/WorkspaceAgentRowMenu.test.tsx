// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { AgentRowMenuContent, useWorkspaceAgentRowMenu } from './WorkspaceAgentRowMenu'

const onOpen = vi.fn()

function Row(props: {
  name?: string
  title?: string
  unread?: boolean
  canToggleRead?: boolean
  canMarkUnread?: boolean
}): React.JSX.Element {
  const menu = useWorkspaceAgentRowMenu()
  return (
    <div data-testid={`row${props.name ?? ''}`} className="relative" {...menu.rowProps}>
      Chat
      <button type="button" data-testid={`row-control${props.name ?? ''}`}>
        x
      </button>
      {menu.menu ? (
        <AgentRowMenuContent
          menu={menu.menu}
          onClose={menu.close}
          title={props.title ?? 'Chat'}
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
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2 })
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

  it('picks an item with Enter at once when the keyboard opened the menu', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(<Row />)
    const control = screen.getByTestId('row-control')
    control.focus()
    fireEvent.contextMenu(control, { clientX: 0, clientY: 0 })
    // Same instant as the opening: only a pointer opening has a release to ignore.
    fireEvent.keyDown(item('Open'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('picks an item with Space at once when the keyboard opened the menu', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(<Row />)
    const control = screen.getByTestId('row-control')
    control.focus()
    fireEvent.contextMenu(control, { clientX: 0, clientY: 0 })
    fireEvent.keyDown(item('Open'), { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('picks an item with Enter at once after a right-click opened the menu', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(<Row />)
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2 })
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    fireEvent.keyDown(item('Open'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores the opening release again when a right-click reopens the open menu', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(<Row />)
    const row = screen.getByTestId('row')
    fireEvent.pointerDown(row, { button: 2 })
    fireEvent.contextMenu(row, { clientX: 40, clientY: 10 })
    // A left press inside the menu ends the first opening's guard.
    fireEvent.pointerDown(item('Copy Title'), { button: 0 })
    vi.setSystemTime(1_792_983_602_000)
    act(() => {
      fireEvent.pointerDown(row, { button: 2 })
      fireEvent.contextMenu(row, { clientX: 50, clientY: 12 })
    })
    const open = item('Open')
    fireEvent.pointerUp(open, { button: 2 })
    fireEvent.click(open)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves focus where an outside click put it', async () => {
    render(
      <>
        <Row />
        <input data-testid="elsewhere" />
      </>
    )
    const control = screen.getByTestId('row-control')
    control.focus()
    fireEvent.contextMenu(control, { clientX: 0, clientY: 0 })
    const elsewhere = screen.getByTestId('elsewhere')
    act(() => {
      fireEvent.pointerDown(elsewhere)
      elsewhere.focus()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('leaves focus on a menu that replaced it', async () => {
    render(
      <>
        <Row name="-a" />
        <Row name="-b" />
      </>
    )
    const first = screen.getByTestId('row-control-a')
    first.focus()
    fireEvent.contextMenu(first, { clientX: 0, clientY: 0 })
    const second = screen.getByTestId('row-control-b')
    act(() => {
      second.focus()
      fireEvent.contextMenu(second, { clientX: 0, clientY: 0 })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByTestId('row-b').getAttribute('data-agent-row-menu-open')).toBe('true')
    expect(screen.getByTestId('row-a').hasAttribute('data-agent-row-menu-open')).toBe(false)
    expect(document.activeElement).not.toBe(first)
  })

  it('leaves focus where Open sent it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_792_983_600_000)
    render(
      <>
        <Row />
        <input data-testid="agent-input" />
      </>
    )
    const input = screen.getByTestId('agent-input')
    onOpen.mockImplementation(() => input.focus())
    const control = screen.getByTestId('row-control')
    control.focus()
    fireEvent.contextMenu(control, { clientX: 0, clientY: 0 })
    act(() => {
      fireEvent.keyDown(item('Open'), { key: 'Enter' })
    })
    vi.useRealTimers()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
  })

  it('offers no Copy Title for a row without a title', () => {
    render(<Row title="  " />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 40, clientY: 10 })
    expect(item('Copy Title').hasAttribute('data-disabled')).toBe(true)
  })

  it('anchors a keyboard opening under the row whatever coordinates it reports', () => {
    render(<Row />)
    const control = screen.getByTestId('row-control')
    control.focus()
    // Chromium can place a keyboard context menu at the focused control.
    fireEvent.contextMenu(control, { clientX: 31, clientY: 17 })
    const anchor = screen.getByTestId('row').querySelector('button[aria-hidden]')
    expect(anchor?.getAttribute('style')).toContain('left: 8px')
  })

  it('anchors a pointer opening at the pointer, even at the window origin', () => {
    render(<Row />)
    const row = screen.getByTestId('row')
    fireEvent.pointerDown(row, { button: 2 })
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 })
    const anchor = row.querySelector('button[aria-hidden]')
    expect(anchor?.getAttribute('style')).toContain('left: 0px')
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
