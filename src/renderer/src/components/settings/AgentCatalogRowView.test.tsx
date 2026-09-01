// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentCatalogRowView, type AgentCatalogRowCallbacks } from './AgentCatalogRowView'
import type { AgentCatalogRow } from './agent-catalog-rows'
import type { CustomTuiAgentId } from '../../../../shared/types'

afterEach(() => cleanup())

function noopCallbacks(): AgentCatalogRowCallbacks {
  return {
    onToggleEnabled: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onRepair: vi.fn(),
    onReviewReferences: vi.fn()
  }
}

const customRow: AgentCatalogRow = {
  kind: 'custom',
  id: 'custom-agent:codex:one' as CustomTuiAgentId,
  baseAgent: 'codex',
  label: 'Nightly Codex',
  commandSummary: 'codex --model o3',
  status: 'enabled',
  enabled: true,
  isDefault: false,
  searchSummary: 'nightly codex'
}

describe('AgentCatalogRowView configured row', () => {
  it('shows label, command summary, status badge and an enable switch', () => {
    render(<AgentCatalogRowView row={customRow} {...noopCallbacks()} />)
    expect(screen.getByText('Nightly Codex')).toBeTruthy()
    expect(screen.getByText('codex --model o3')).toBeTruthy()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Enable Nightly Codex/ })).toBeTruthy()
  })

  it('toggles enabled through the switch', () => {
    const callbacks = noopCallbacks()
    render(<AgentCatalogRowView row={customRow} {...callbacks} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(callbacks.onToggleEnabled).toHaveBeenCalledWith(customRow, false)
  })
})

describe('AgentCatalogRowView repair row', () => {
  it('renders a Repair action and a generic label when the name is unsafe', () => {
    const callbacks = noopCallbacks()
    const row: AgentCatalogRow = {
      kind: 'repair',
      repairToken: 'tok',
      baseAgent: 'codex',
      label: null,
      issues: [],
      draftAvailability: 'available',
      route: 'discard-replace',
      searchSummary: ''
    }
    render(<AgentCatalogRowView row={row} {...callbacks} />)
    expect(screen.getByText('Custom agent')).toBeTruthy()
    fireEvent.click(screen.getByText('Repair'))
    expect(callbacks.onRepair).toHaveBeenCalledWith(row)
  })
})

describe('AgentCatalogRowView deleted row', () => {
  it('shows the reference count and a Review references action', () => {
    const callbacks = noopCallbacks()
    const row: AgentCatalogRow = {
      kind: 'deleted',
      id: 'custom-agent:codex:gone' as CustomTuiAgentId,
      baseAgent: 'codex',
      label: 'Retired',
      referenceCount: 2,
      searchSummary: ''
    }
    render(<AgentCatalogRowView row={row} {...callbacks} />)
    expect(screen.getByText('Deleted — still used by 2 items')).toBeTruthy()
    fireEvent.click(screen.getByText('Review references'))
    expect(callbacks.onReviewReferences).toHaveBeenCalledWith(row)
  })

  it('shows plain "Deleted" when the readable reference count is zero', () => {
    const row: AgentCatalogRow = {
      kind: 'deleted',
      id: 'custom-agent:codex:gone' as CustomTuiAgentId,
      baseAgent: 'codex',
      label: 'Retired',
      referenceCount: 0,
      searchSummary: ''
    }
    render(<AgentCatalogRowView row={row} {...noopCallbacks()} />)
    expect(screen.getByText('Deleted')).toBeTruthy()
    expect(screen.queryByText(/still used by/)).toBeNull()
  })
})
