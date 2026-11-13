// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    agentDashboardDrawerOpen: false,
    setAgentDashboardDrawerOpen: vi.fn(),
    settings: {}
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 0, working: 0, done: 0, idle: 0 })
}))

import AgentDashboardSidebarEntry from './AgentDashboardSidebarEntry'

afterEach(() => {
  cleanup()
  mocks.state = {
    agentDashboardDrawerOpen: false,
    setAgentDashboardDrawerOpen: vi.fn(),
    settings: {}
  }
})

describe('AgentDashboardSidebarEntry active state', () => {
  it('stays quiet while the dashboard drawer is closed', () => {
    render(<AgentDashboardSidebarEntry />)
    const row = screen.getByRole('button', { name: /Agent Dashboard/ })
    expect(row.getAttribute('aria-current')).toBeNull()
  })

  it('marks the dashboard row as the current view while its drawer is open', () => {
    mocks.state = {
      ...mocks.state,
      agentDashboardDrawerOpen: true
    }
    render(<AgentDashboardSidebarEntry />)
    const row = screen.getByRole('button', { name: /Agent Dashboard/ })
    expect(row.getAttribute('aria-current')).toBe('page')
  })
})
