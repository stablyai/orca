// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AgentCatalogStatusBadge, agentCatalogStatusLabel } from './AgentCatalogStatusBadge'
import type { AgentCatalogRowStatus } from './agent-catalog-rows'

afterEach(() => cleanup())

const ALL_STATUSES: AgentCatalogRowStatus[] = [
  'enabled',
  'disabled',
  'base-disabled',
  'not-installed',
  'custom-executable',
  'custom-path',
  'repair-required'
]

describe('agentCatalogStatusLabel', () => {
  it('returns a distinct non-empty label for every status', () => {
    const labels = ALL_STATUSES.map(agentCatalogStatusLabel)
    expect(labels.every((label) => label.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(ALL_STATUSES.length)
  })

  it('uses the exact contract copy for the PATH and repair states', () => {
    expect(agentCatalogStatusLabel('custom-path')).toBe('Custom PATH')
    expect(agentCatalogStatusLabel('repair-required')).toBe('Repair required')
  })
})

describe('AgentCatalogStatusBadge', () => {
  it('renders the status label as visible text', () => {
    render(<AgentCatalogStatusBadge status="custom-executable" />)
    expect(screen.getByText('Custom executable')).toBeTruthy()
  })
})
