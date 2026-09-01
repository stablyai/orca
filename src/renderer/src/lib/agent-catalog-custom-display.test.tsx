// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CustomTuiAgentId } from '../../../shared/types'
import { AgentIcon, getAgentLabel } from './agent-catalog'
import { registerAgentCatalogSettingsSource } from './agent-catalog-settings-source'

const CUSTOM = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

afterEach(() => {
  cleanup()
  registerAgentCatalogSettingsSource(() => null)
})

describe('custom agent display', () => {
  it('labels a live custom agent with its own name', () => {
    registerAgentCatalogSettingsSource(() => ({
      customTuiAgents: [
        { id: CUSTOM, baseAgent: 'codex', label: 'My Codex', args: '', env: {}, syncEnv: false }
      ]
    }))
    expect(getAgentLabel(CUSTOM)).toBe('My Codex')
  })

  it('labels a tombstoned custom agent from the deleted list', () => {
    registerAgentCatalogSettingsSource(() => ({
      deletedCustomTuiAgents: [
        { id: CUSTOM, baseAgent: 'codex', label: 'Gone Codex', deletedAt: 0 }
      ]
    }))
    expect(getAgentLabel(CUSTOM)).toBe('Gone Codex')
  })

  it('renders the base harness icon for a custom agent', () => {
    registerAgentCatalogSettingsSource(() => ({
      customTuiAgents: [
        { id: CUSTOM, baseAgent: 'codex', label: 'My Codex', args: '', env: {}, syncEnv: false }
      ]
    }))
    const { container } = render(<AgentIcon agent={CUSTOM} />)
    expect(container.innerHTML).toBe(render(<AgentIcon agent="codex" />).container.innerHTML)
  })

  it('falls back to the unknown glyph when the id resolves to no catalog row', () => {
    render(<AgentIcon agent={CUSTOM} />)
    expect(screen.getByText('?')).toBeTruthy()
  })
})
