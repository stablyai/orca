// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CustomAgentRowActions } from './CustomAgentRowActions'

// Render the menu content inline so items are queryable without Radix's
// pointer-capture/portal machinery (the repo idiom for menu unit tests).
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: {
    children: ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button type="button" data-menu-item disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

afterEach(() => cleanup())

describe('CustomAgentRowActions', () => {
  it('offers Edit, Duplicate, and Delete for a custom row', () => {
    render(
      <CustomAgentRowActions
        rowKind="custom"
        agentLabel="My Codex"
        onEdit={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
      />
    )
    expect(screen.getByText('Edit')).toBeTruthy()
    expect(screen.getByText('Duplicate')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('omits Delete for a built-in row', () => {
    render(
      <CustomAgentRowActions
        rowKind="built-in"
        agentLabel="Codex"
        onEdit={() => {}}
        onDuplicate={() => {}}
      />
    )
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText('Edit launch settings')).toBeTruthy()
  })

  it('fires the delete callback when chosen', () => {
    const onDelete = vi.fn()
    render(
      <CustomAgentRowActions
        rowKind="custom"
        agentLabel="My Codex"
        onEdit={() => {}}
        onDuplicate={() => {}}
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('stages a disabled built-in Edit when a reason is given', () => {
    const onEdit = vi.fn()
    render(
      <CustomAgentRowActions
        rowKind="built-in"
        agentLabel="Codex"
        editDisabledReason="Editing built-in launch settings is not available yet."
        onEdit={onEdit}
        onDuplicate={() => {}}
      />
    )
    const edit = screen.getByText('Edit launch settings') as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    fireEvent.click(edit)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('keeps a custom Delete visible but disabled while staged', () => {
    const onDelete = vi.fn()
    render(
      <CustomAgentRowActions
        rowKind="custom"
        agentLabel="My Codex"
        deleteDisabledReason="Deleting a custom agent is not available yet."
        onEdit={() => {}}
        onDuplicate={() => {}}
        onDelete={onDelete}
      />
    )
    const del = screen.getByText('Delete') as HTMLButtonElement
    expect(del.disabled).toBe(true)
    fireEvent.click(del)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('names the agent in the trigger accessible label', () => {
    render(
      <CustomAgentRowActions
        rowKind="custom"
        agentLabel="Nightly"
        onEdit={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /Nightly/ })).toBeTruthy()
  })
})
