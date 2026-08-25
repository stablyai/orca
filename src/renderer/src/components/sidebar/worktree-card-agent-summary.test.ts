import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow, getCompactAgentSecondary } from './worktree-card-compact-agent-row'
import { getAgentDotState, summarizeAgents } from './worktree-card-agent-summary'

function monitoringAgent(): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'working',
    agentType: 'claude',
    startedAt: 1,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    entry: {
      state: 'working',
      workingMode: 'monitoring',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      paneKey: 'tab-1:leaf-1'
    }
  }
}

describe('worktree card agent summary', () => {
  it('presents passive working as monitoring', () => {
    const agent = monitoringAgent()

    expect(getAgentDotState(agent)).toBe('monitoring')
    expect(getCompactAgentSecondary(agent)).toBe('Monitoring background tasks')
    expect(summarizeAgents([agent], 'Agent')).toBe('Agent monitoring')
  })

  it('keeps monitoring visible before a compact row prompt', () => {
    const agent = monitoringAgent()
    agent.entry.prompt = 'Run background checks'

    const markup = renderToStaticMarkup(
      createElement(CompactAgentRow, { agent, now: 2000, onActivate: vi.fn() })
    )

    expect(markup).toContain('title="Monitoring background tasks - Run background checks"')
    expect(markup).toMatch(
      /Monitoring background tasks<\/span><span[^>]*> - Run background checks<\/span>/
    )
  })

  it('lists interrupted outcomes before clean completions', () => {
    const done = monitoringAgent()
    done.state = 'done'
    done.entry.state = 'done'
    done.entry.workingMode = undefined
    const interrupted = {
      ...done,
      paneKey: 'tab-1:leaf-2',
      entry: { ...done.entry, paneKey: 'tab-1:leaf-2', interrupted: true }
    }

    expect(summarizeAgents([done, interrupted], 'Agents')).toBe('Agents: 1 interrupted, 1 done')
  })
})
