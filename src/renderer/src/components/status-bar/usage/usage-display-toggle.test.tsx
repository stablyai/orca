// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../../store'
import { UsageDisplayToggle } from './usage-meter'

const uiSet = vi.fn(() => Promise.resolve())

beforeEach(() => {
  uiSet.mockClear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toggle only persists through window.api.ui.set.
  window.api = { ui: { set: uiSet } } as unknown as typeof window.api
  useAppStore.setState({ usagePercentageDisplay: 'used' })
})

afterEach(cleanup)

it('flips the persisted Used/Left setting from the keyboard and keeps the menu open', async () => {
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
      <DropdownMenuContent>
        <UsageDisplayToggle asMenuItem />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const toggle = await screen.findByRole('menuitem', { name: 'Used' })
  expect(toggle.getAttribute('aria-description')).toBe('Show remaining usage')
  toggle.focus()
  fireEvent.keyDown(toggle, { key: 'Enter' })

  expect(useAppStore.getState().usagePercentageDisplay).toBe('remaining')
  expect(uiSet).toHaveBeenCalledWith(
    expect.objectContaining({ usagePercentageDisplay: 'remaining' })
  )
  expect(screen.getByRole('menu')).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Left' }))
  expect(useAppStore.getState().usagePercentageDisplay).toBe('used')
})
