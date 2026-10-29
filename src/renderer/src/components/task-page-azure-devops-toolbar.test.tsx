// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import {
  AzureDevOpsToolbar,
  type AzureDevOpsToolbarProps
} from '@/components/task-page/azure-devops/Toolbar'

afterEach(() => cleanup())

function props(overrides: Partial<AzureDevOpsToolbarProps> = {}): AzureDevOpsToolbarProps {
  return {
    teams: [
      { id: 't1', name: 'Platform', isDefault: false },
      { id: 't2', name: 'Mobile', isDefault: true }
    ],
    selectedTeamName: 'Mobile',
    onSelectTeam: vi.fn(),
    levels: [
      {
        id: 'feat',
        name: 'Features',
        rank: 3,
        kind: 'portfolio',
        workItemTypes: ['Feature'],
        columnFields: [],
        hidden: false
      },
      {
        id: 'req',
        name: 'Backlog items',
        rank: 2,
        kind: 'requirement',
        workItemTypes: ['PBI'],
        columnFields: [],
        hidden: false
      }
    ],
    selectedLevelId: 'req',
    onSelectLevel: vi.fn(),
    view: 'backlog',
    onSelectView: vi.fn(),
    boardAvailable: false,
    showParents: false,
    onToggleShowParents: vi.fn(),
    showInProgress: true,
    onToggleShowInProgress: vi.fn(),
    onResetColumnWidths: null,
    onRefresh: vi.fn(),
    refreshing: false,
    ...overrides
  }
}

describe('AzureDevOpsToolbar', () => {
  it('shows the selected team and level', () => {
    render(<AzureDevOpsToolbar {...props()} />)
    expect(screen.getByRole('button', { name: /Mobile/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Backlog items/ })).toBeInTheDocument()
  })

  it('disables the Board view when it is not available', () => {
    render(<AzureDevOpsToolbar {...props()} />)
    expect(screen.getByRole('radio', { name: 'Board' })).toBeDisabled()
  })

  it('toggles In progress items from the view options menu', () => {
    const p = props()
    render(<AzureDevOpsToolbar {...p} />)
    const trigger = screen.getByRole('button', { name: 'View options' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'In progress items' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(p.onToggleShowInProgress).toHaveBeenCalledWith(false)
  })

  it('offers Reset column widths only while local overrides exist', () => {
    const onResetColumnWidths = vi.fn()
    const { unmount } = render(<AzureDevOpsToolbar {...props()} />)
    let trigger = screen.getByRole('button', { name: 'View options' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Reset column widths' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    unmount()

    render(<AzureDevOpsToolbar {...props({ onResetColumnWidths })} />)
    trigger = screen.getByRole('button', { name: 'View options' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset column widths' }))
    expect(onResetColumnWidths).toHaveBeenCalledTimes(1)
  })

  it('toggles Show parents', () => {
    const p = props()
    render(<AzureDevOpsToolbar {...p} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show parents' }))
    expect(p.onToggleShowParents).toHaveBeenCalledWith(true)
  })
})
