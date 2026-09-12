// @vitest-environment happy-dom

import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'

const popoverMock = vi.hoisted(() => ({
  open: false,
  onOpenChange: undefined as ((open: boolean) => void) | undefined
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Radix `asChild` renders the child itself and owns its click; mirror that so
// the trigger button is clickable and content mounts only while open.
vi.mock('@/components/ui/popover', async () => {
  const { cloneElement } = await import('react')
  return {
    Popover: ({
      children,
      open,
      onOpenChange
    }: {
      children: React.ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      popoverMock.open = open ?? false
      popoverMock.onOpenChange = onOpenChange
      return <div>{children}</div>
    },
    PopoverTrigger: ({ children }: { children: React.ReactElement }) =>
      cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => popoverMock.onOpenChange?.(!popoverMock.open)
      }),
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      popoverMock.open ? <div>{children}</div> : null
  }
})

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    value,
    placeholder,
    onValueChange
  }: {
    value?: string
    placeholder?: string
    onValueChange?: (value: string) => void
  }) => (
    <input
      data-slot="command-input"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onValueChange?.(event.target.value)}
    />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    'data-testid': dataTestId
  }: {
    children: React.ReactNode
    onSelect?: (value: string) => void
    'data-testid'?: string
  }) => (
    <button
      type="button"
      data-testid={dataTestId}
      onClick={() => onSelect?.('repo::/worktrees/beta')}
    >
      {children}
    </button>
  )
}))

const { SourceControlWorktreePicker, shouldShowSourceControlNonActiveWorktreeNotice } =
  await import('./worktree-picker')

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo::/worktrees/alpha',
    repoId: 'repo',
    displayName: 'alpha',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    path: '/worktrees/alpha',
    head: '0123456789abcdef',
    branch: 'refs/heads/feature/alpha',
    isBare: false,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const WORKTREES: readonly Worktree[] = [
  makeWorktree({
    id: 'repo::/main',
    displayName: 'orca',
    path: '/main',
    branch: 'refs/heads/main',
    isMainWorktree: true
  }),
  makeWorktree({ id: 'repo::/worktrees/alpha', displayName: 'alpha' }),
  makeWorktree({
    id: 'repo::/worktrees/beta',
    displayName: 'beta',
    path: '/worktrees/beta',
    branch: 'refs/heads/hotfix/login'
  })
]

afterEach(() => {
  cleanup()
  popoverMock.open = false
})

describe('SourceControlWorktreePicker', () => {
  it('shows the selected worktree on the trigger', () => {
    render(
      <SourceControlWorktreePicker
        worktrees={WORKTREES}
        selectedWorktreeId="repo::/worktrees/alpha"
        currentWorktreeId="repo::/main"
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByTestId('source-control-worktree-picker')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('selects another worktree from the list', () => {
    const onSelect = vi.fn()
    render(
      <SourceControlWorktreePicker
        worktrees={WORKTREES}
        selectedWorktreeId="repo::/worktrees/alpha"
        currentWorktreeId="repo::/main"
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByTestId('source-control-worktree-picker'))
    fireEvent.click(
      screen.getByTestId('source-control-worktree-picker-option-repo::/worktrees/beta')
    )

    expect(onSelect).toHaveBeenCalledWith('repo::/worktrees/beta')
  })

  it('filters the list as the user types', () => {
    render(
      <SourceControlWorktreePicker
        worktrees={WORKTREES}
        selectedWorktreeId="repo::/main"
        currentWorktreeId="repo::/main"
        onSelect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('source-control-worktree-picker'))
    const input = screen.getByPlaceholderText('Search worktrees…')
    fireEvent.change(input, { target: { value: 'hotfix' } })

    expect(screen.getByText('beta')).toBeTruthy()
    expect(
      screen.queryByTestId('source-control-worktree-picker-option-repo::/worktrees/alpha')
    ).toBeNull()
    expect(screen.queryByTestId('source-control-worktree-picker-option-repo::/main')).toBeNull()
  })

  it('marks the app-active worktree as current', () => {
    render(
      <SourceControlWorktreePicker
        worktrees={WORKTREES}
        selectedWorktreeId="repo::/main"
        currentWorktreeId="repo::/main"
        onSelect={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('source-control-worktree-picker'))
    expect(screen.getByText('Current')).toBeTruthy()
  })
})

describe('shouldShowSourceControlNonActiveWorktreeNotice', () => {
  it('shows only when the viewed worktree differs from the app-active one', () => {
    expect(shouldShowSourceControlNonActiveWorktreeNotice('a', 'a')).toBe(false)
    expect(shouldShowSourceControlNonActiveWorktreeNotice('b', 'a')).toBe(true)
    expect(shouldShowSourceControlNonActiveWorktreeNotice('', 'a')).toBe(true)
  })
})
