// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuickNote } from '../../../../shared/quick-note-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    params ? fallback.replace(/\{\{value0\}\}/g, String(params.value0)) : fallback
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { TabBarQuickNotesMenu } from './TabBarQuickNotesMenu'

const notes: QuickNote[] = [
  { id: 'a', label: 'Email signature', body: 'Best,\nFrank' },
  { id: 'b', label: 'Deploy block', body: 'kubectl rollout status' }
]

function renderMenu(over: Partial<Parameters<typeof TabBarQuickNotesMenu>[0]> = {}) {
  const props = {
    notes,
    mostRecent: notes[1],
    onCopyNote: vi.fn(),
    onAddNote: vi.fn(),
    onEditNote: vi.fn(),
    onDeleteNote: vi.fn(),
    ...over
  }
  render(<TabBarQuickNotesMenu {...props} />)
  return props
}

afterEach(cleanup)

describe('TabBarQuickNotesMenu', () => {
  it('copies the most recent note from the primary split-button', async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Copy quick note: Deploy block' }))
    expect(props.onCopyNote).toHaveBeenCalledWith(notes[1])
  })

  it('copies a note picked from the list', async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.click(screen.getByText('Email signature'))
    expect(props.onCopyNote).toHaveBeenCalledWith(notes[0])
  })

  it('filters the list by the search query', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.type(screen.getByPlaceholderText('Search quick notes...'), 'deploy')
    expect(screen.queryByText('Email signature')).not.toBeInTheDocument()
    // Body preview is unique to the list row (not shown on the split-button).
    expect(screen.getByText('kubectl rollout status')).toBeInTheDocument()
  })

  it('routes the row actions to edit and delete', async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Edit Email signature' }))
    expect(props.onEditNote).toHaveBeenCalledWith(notes[0])
    await user.click(screen.getByRole('button', { name: 'Remove Deploy block' }))
    expect(props.onDeleteNote).toHaveBeenCalledWith(notes[1])
  })

  it('invokes onAddNote from the footer button', async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.click(screen.getByRole('button', { name: 'Note' }))
    expect(props.onAddNote).toHaveBeenCalledOnce()
  })
})
