// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Share2 } from 'lucide-react'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect,
    role,
    'aria-checked': ariaChecked
  }: {
    children: React.ReactNode
    onSelect: () => void
    role?: string
    'aria-checked'?: boolean
  }) => (
    <button role={role} aria-checked={ariaChecked} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

import { BrowserChromeFoldedMenuItems } from './browser-chrome-folded-tools'

afterEach(cleanup)

describe('BrowserChromeFoldedMenuItems', () => {
  it('runs ordinary actions directly', () => {
    const onSelect = vi.fn()
    render(
      <BrowserChromeFoldedMenuItems
        tools={[{ stage: 'share', label: 'Share', icon: Share2, onSelect }]}
        deferUntilClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('defers popover actions until the menu closes', () => {
    const onSelect = vi.fn()
    const deferUntilClose = vi.fn()
    render(
      <BrowserChromeFoldedMenuItems
        tools={[
          {
            stage: 'share',
            label: 'Share',
            icon: Share2,
            onSelect,
            deferUntilMenuClose: true
          }
        ]}
        deferUntilClose={deferUntilClose}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(deferUntilClose).toHaveBeenCalledWith(onSelect)
  })

  it('preserves active state for folded toggle tools', () => {
    render(
      <BrowserChromeFoldedMenuItems
        tools={[
          {
            stage: 'draw',
            label: 'Draw',
            icon: Share2,
            onSelect: vi.fn(),
            active: true
          }
        ]}
        deferUntilClose={vi.fn()}
      />
    )

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Draw' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('gives toggle tools their own section, split from the actions by a divider', () => {
    const { container } = render(
      <BrowserChromeFoldedMenuItems
        tools={[
          { stage: 'draw', label: 'Draw', icon: Share2, onSelect: vi.fn(), active: false },
          { stage: 'share', label: 'Share', icon: Share2, onSelect: vi.fn() }
        ]}
        deferUntilClose={vi.fn()}
      />
    )

    // Rendered order: Draw, divider, Share, closing divider.
    expect(Array.from(container.querySelectorAll('button, hr')).map((el) => el.tagName)).toEqual([
      'BUTTON',
      'HR',
      'BUTTON',
      'HR'
    ])
  })
})
