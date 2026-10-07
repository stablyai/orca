// why: the entry points render through React DOM, so @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AddToTowerContextDialog,
  AddToTowerEmptyAction,
  AddToTowerEntryContext,
  AddToTowerMenuItem
} from './add-to-tower-entry'

const originalApi = window.api
const addLink = vi.fn()
const onChanged = vi.fn()
const PLACEHOLDER = 'https://github.com/org/repo/pull/12 or repo#12'
const LABEL = 'Add to control tower…'

function MenuHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AddToTowerMenuItem onOpen={() => setOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <AddToTowerContextDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

const enabledEntry = { parentWorkspaceKey: 'tower', onChanged }

function withEntry(ui: React.ReactNode, enabled: boolean): React.JSX.Element {
  return (
    <AddToTowerEntryContext.Provider value={enabled ? enabledEntry : null}>
      {ui}
    </AddToTowerEntryContext.Provider>
  )
}

beforeEach(() => {
  addLink.mockReset()
  onChanged.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { ...originalApi, git: { lineageAddManualLink: addLink } }
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: originalApi })
})

describe('add-to-tower entry points', () => {
  it('opens the shared dialog from the menu item and refreshes on success', async () => {
    addLink.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(withEntry(<MenuHarness />, true))
    await user.click(screen.getByText('menu'))
    await user.click(await screen.findByText(LABEL))
    expect(await screen.findByRole('dialog', { name: 'Add to control tower' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Pull request' }))
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'api#12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(addLink).toHaveBeenCalledWith({
        parentWorkspaceKey: 'tower',
        reference: 'api#12',
        target: { kind: 'pr', reference: 'api#12' }
      })
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('renders no menu item when lineage is unsupported', async () => {
    const user = userEvent.setup()
    render(withEntry(<MenuHarness />, false))
    await user.click(screen.getByText('menu'))
    await screen.findByRole('menu')
    expect(screen.queryByText(LABEL)).toBeNull()
  })

  it('offers the empty-state action only when supported, and it opens the same dialog', async () => {
    const { unmount } = render(withEntry(<AddToTowerEmptyAction />, true))
    fireEvent.click(screen.getByRole('button', { name: LABEL }))
    expect(await screen.findByRole('dialog', { name: 'Add to control tower' })).toBeInTheDocument()
    unmount()
    const { container } = render(withEntry(<AddToTowerEmptyAction />, false))
    expect(container).toBeEmptyDOMElement()
  })
})
