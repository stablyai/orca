// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { AgentCatalogRow, type AgentCatalogRowProps } from './AgentCatalogRow'

function makeProps(overrides: Partial<AgentCatalogRowProps> = {}): AgentCatalogRowProps {
  return {
    agentId: 'claude',
    label: 'Claude',
    homepageUrl: 'https://code.claude.com/docs',
    defaultCmd: 'claude',
    defaultArgs: '',
    // Why: Claude ships no default env, which is the case that used to hide
    // the Environment field entirely.
    defaultEnv: {},
    isDetected: true,
    isEnabled: true,
    isDefault: true,
    cmdOverride: undefined,
    argsOverride: '',
    envOverride: {},
    onSetDefault: vi.fn(),
    onSetEnabled: vi.fn(),
    onSaveOverride: vi.fn(),
    onSaveArgs: vi.fn(),
    onSaveEnv: vi.fn(),
    ...overrides
  }
}

function render(props: AgentCatalogRowProps): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(<AgentCatalogRow {...props} />)
  })
  return container
}

// Why: the row auto-expands when an override already exists (cmdOpen seeds from
// hasOverrides), so clicking unconditionally would collapse it instead.
function expandOverrides(container: HTMLElement): void {
  const toggle = Array.from(container.querySelectorAll('button')).find((entry) =>
    /command override/i.test(entry.getAttribute('aria-label') ?? entry.textContent ?? '')
  )
  expect(toggle, 'command override toggle should exist').toBeTruthy()
  const isCollapsed = /expand/i.test(
    toggle?.getAttribute('aria-label') ?? toggle?.textContent ?? ''
  )
  if (!isCollapsed) {
    return
  }
  act(() => {
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('AgentCatalogRow', () => {
  it('renders the Environment field for an agent with no default env and no override', () => {
    const container = render(makeProps())
    expandOverrides(container)
    expect(container.textContent).toContain('Environment')
  })

  it('still renders the Environment field when an override already exists', () => {
    const container = render(makeProps({ envOverride: { OTEL_METRICS_EXPORTER: 'otlp' } }))
    expandOverrides(container)
    expect(container.textContent).toContain('Environment')
  })
})
