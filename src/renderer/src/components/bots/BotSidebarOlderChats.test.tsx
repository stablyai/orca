// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { BotSidebarOlderChats } from './BotSidebarOlderChats'

afterEach(cleanup)

function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <BotSidebarOlderChats count={3} open={open} onToggle={() => setOpen(!open)}>
      <button type="button">Old review chat</button>
    </BotSidebarOlderChats>
  )
}

const toggle = () => screen.getByRole('button', { name: /older/i })

describe('BotSidebarOlderChats', () => {
  it('starts folded with the count, and shows the older rows below the toggle when opened', () => {
    render(<Harness />)
    expect(toggle().textContent).toBe('Show 3 older')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Old review chat')).toBeNull()
    fireEvent.click(toggle())
    expect(toggle().textContent).toBe('Hide older')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const row = screen.getByText('Old review chat')
    expect(toggle().compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle().getAttribute('aria-controls')).toBe(row.parentElement?.id)
  })

  it('is a keyboard button: it takes focus and toggles from the keyboard', () => {
    render(<Harness />)
    toggle().focus()
    expect(document.activeElement).toBe(toggle())
    // A native button turns Enter and Space into a click.
    expect(toggle().tagName).toBe('BUTTON')
    expect(toggle().getAttribute('type')).toBe('button')
  })

  it('moves focus to the toggle when it hides the row that had focus', () => {
    render(<Harness initiallyOpen />)
    const row = screen.getByText('Old review chat')
    row.focus()
    expect(document.activeElement).toBe(row)
    fireEvent.click(toggle())
    expect(screen.queryByText('Old review chat')).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })
})
