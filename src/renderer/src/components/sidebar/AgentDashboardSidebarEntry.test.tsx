// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import AgentDashboardSidebarEntry from './AgentDashboardSidebarEntry'

type SidebarState = {
  settings: { experimentalAgentDashboardShowIdle: boolean }
  agentDashboardDrawerOpen: boolean
  setAgentDashboardDrawerOpen: (open: boolean) => void
}

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 1, working: 2, done: 3, idle: 4 })
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: SidebarState) => unknown) =>
    selector({
      settings: { experimentalAgentDashboardShowIdle: true },
      agentDashboardDrawerOpen: false,
      setAgentDashboardDrawerOpen: vi.fn()
    })
}))

describe('AgentDashboardSidebarEntry turn-ended summary', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })
  afterEach(cleanup)

  it('names the ended-turn count and explains its meaning in the title', () => {
    render(<AgentDashboardSidebarEntry />)

    expect(screen.getByRole('img', { name: 'Turn ended: 3' })).toHaveAttribute(
      'title',
      'An agent turn ended. Task acceptance has not been verified.'
    )
    expect(screen.getByRole('img', { name: 'Idle: 4' })).not.toHaveAttribute('title')
    expect(screen.queryByRole('img', { name: 'Done: 3' })).not.toBeInTheDocument()
  })

  it('uses the Chinese ended-turn label and explanation', async () => {
    await i18n.changeLanguage('zh')
    render(<AgentDashboardSidebarEntry />)

    expect(screen.getByRole('img', { name: '本轮结束: 3' })).toHaveAttribute(
      'title',
      '仅表示智能体本轮已结束，不代表任务已通过验收。'
    )
  })
})
