// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { AgentCatalogRow } from './AgentCatalogRow'

function getRowProps(): AgentCatalogRowProps {
  return {
    agentId: 'claude',
    label: 'Claude',
    homepageUrl: 'https://code.claude.com/docs',
    defaultCmd: 'claude',
    defaultArgs: '',
    defaultEnv: {},
    isDetected: true,
    isEnabled: true,
    isDefault: false,
    cmdOverride: undefined,
    argsOverride: '',
    envOverride: {},
    onSetDefault: vi.fn(),
    onSetEnabled: vi.fn(),
    onSaveOverride: vi.fn(),
    onSaveArgs: vi.fn(),
    onSaveEnv: vi.fn()
  }
}

describe('AgentCatalogRow', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the Environment input after expanding an agent with no env configured', () => {
    render(<AgentCatalogRow {...getRowProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand command override' }))

    expect(screen.getByText('Environment')).toBeTruthy()
    expect(screen.getByPlaceholderText('No default environment')).toBeTruthy()
  })
})
