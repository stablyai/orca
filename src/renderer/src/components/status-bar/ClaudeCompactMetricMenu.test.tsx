// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ClaudeCompactMetricMenu } from './ClaudeCompactMetricMenu'

afterEach(cleanup)

const claude: ProviderRateLimits = {
  provider: 'claude',
  session: {
    usedPercent: 3,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null
  },
  weekly: null,
  fableWeekly: {
    usedPercent: 100,
    windowMinutes: 10_080,
    resetsAt: null,
    resetDescription: null
  },
  updatedAt: 1,
  error: null,
  status: 'ok'
}

function renderMenu(onValueChange = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <DropdownMenu open onOpenChange={() => {}}>
      <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ClaudeCompactMetricMenu claude={claude} value="weekly" onValueChange={onValueChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return onValueChange
}

describe('ClaudeCompactMetricMenu', () => {
  it('keeps an unavailable saved choice checked and disables absent choices', () => {
    renderMenu()

    const weekly = screen.getByRole('menuitemradio', { name: 'Weekly' })
    expect(screen.getByRole('group', { name: 'Compact metric' })).toBeTruthy()
    expect(weekly.getAttribute('data-state')).toBe('checked')
    expect(weekly.hasAttribute('data-disabled')).toBe(true)
    expect(
      screen.getByRole('menuitemradio', { name: 'Automatic' }).hasAttribute('data-disabled')
    ).toBe(false)
    expect(
      screen.getByRole('menuitemradio', { name: 'Session' }).hasAttribute('data-disabled')
    ).toBe(false)
    expect(screen.getByRole('menuitemradio', { name: 'Fable' }).hasAttribute('data-disabled')).toBe(
      false
    )
  })

  it('changes the saved choice through the radio group', async () => {
    const onValueChange = renderMenu()

    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Session' }))

    expect(onValueChange).toHaveBeenCalledWith('session')
  })

  it('uses the menu primitive keyboard navigation and skips a disabled choice', async () => {
    renderMenu()
    const automatic = screen.getByRole('menuitemradio', { name: 'Automatic' })
    const session = screen.getByRole('menuitemradio', { name: 'Session' })
    const fable = screen.getByRole('menuitemradio', { name: 'Fable' })

    automatic.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(session)
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(fable)
  })
})
