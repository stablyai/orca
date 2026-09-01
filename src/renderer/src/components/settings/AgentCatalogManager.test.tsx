// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentCatalogManager } from './AgentCatalogManager'
import type { AgentCatalogRow } from './agent-catalog-rows'
import type { AgentCatalogRowCallbacks } from './AgentCatalogRowView'
import type { CustomTuiAgentId } from '../../../../shared/types'

afterEach(() => cleanup())

function callbacks(): AgentCatalogRowCallbacks {
  return {
    onToggleEnabled: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onRepair: vi.fn(),
    onReviewReferences: vi.fn()
  }
}

const builtInRow: AgentCatalogRow = {
  kind: 'built-in',
  id: 'codex',
  baseAgent: 'codex',
  label: 'Codex',
  commandSummary: 'codex',
  status: 'enabled',
  enabled: true,
  isDefault: false,
  searchSummary: 'codex codex'
}

const customRow: AgentCatalogRow = {
  kind: 'custom',
  id: 'custom-agent:codex:one' as CustomTuiAgentId,
  baseAgent: 'codex',
  label: 'Nightly',
  commandSummary: 'codex',
  status: 'enabled',
  enabled: true,
  isDefault: false,
  searchSummary: 'nightly codex'
}

describe('AgentCatalogManager', () => {
  it('shows the zero-custom helper only when no user agents exist', () => {
    const { rerender } = render(
      <AgentCatalogManager rows={[builtInRow]} onNewAgent={vi.fn()} {...callbacks()} />
    )
    expect(screen.getByText(/Duplicate a built-in or create a custom agent/)).toBeTruthy()
    rerender(
      <AgentCatalogManager rows={[builtInRow, customRow]} onNewAgent={vi.fn()} {...callbacks()} />
    )
    expect(screen.queryByText(/Duplicate a built-in or create a custom agent/)).toBeNull()
  })

  it('fires onNewAgent from the primary action', () => {
    const onNewAgent = vi.fn()
    render(<AgentCatalogManager rows={[builtInRow]} onNewAgent={onNewAgent} {...callbacks()} />)
    fireEvent.click(screen.getByText('New agent'))
    expect(onNewAgent).toHaveBeenCalledTimes(1)
  })

  it('hides the New action in read-only paired mode', () => {
    render(
      <AgentCatalogManager rows={[builtInRow]} readOnly onNewAgent={vi.fn()} {...callbacks()} />
    )
    expect(screen.queryByText('New agent')).toBeNull()
  })

  it('exposes the detection Refresh action when provided', () => {
    const onRefresh = vi.fn()
    render(
      <AgentCatalogManager
        rows={[builtInRow]}
        onNewAgent={vi.fn()}
        onRefresh={onRefresh}
        {...callbacks()}
      />
    )
    fireEvent.click(screen.getByText('Refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
