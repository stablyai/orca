// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadReadToggle } from './ActivityPrototypePage'

describe('ActivityThreadReadToggle', () => {
  afterEach(() => cleanup())

  it('marks an unread thread read', () => {
    const onMarkRead = vi.fn()
    const onMarkUnread = vi.fn()
    render(
      <TooltipProvider>
        <ActivityThreadReadToggle unread onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark thread read' }))

    expect(onMarkRead).toHaveBeenCalledOnce()
    expect(onMarkUnread).not.toHaveBeenCalled()
  })

  it('marks a read thread unread', () => {
    const onMarkRead = vi.fn()
    const onMarkUnread = vi.fn()
    render(
      <TooltipProvider>
        <ActivityThreadReadToggle
          unread={false}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark thread unread' }))

    expect(onMarkUnread).toHaveBeenCalledOnce()
    expect(onMarkRead).not.toHaveBeenCalled()
  })
})
