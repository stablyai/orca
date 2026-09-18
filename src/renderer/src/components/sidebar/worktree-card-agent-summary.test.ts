import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
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

function orderedTitles(markup: string): string[] {
  return [...markup.matchAll(/\stitle="([^"]*)"/g)].map((match) => match[1])
}

function renderCompactAgentRow(props: React.ComponentProps<typeof CompactAgentRow>): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(CompactAgentRow, props))
  )
}

describe('worktree card agent summary', () => {
  it('presents passive working as monitoring', () => {
    const agent = monitoringAgent()

    expect(getAgentDotState(agent)).toBe('monitoring')
    expect(getCompactAgentSecondary(agent, Date.now())).toBe('Monitoring background tasks')
    expect(summarizeAgents([agent], 'Agent')).toBe('Agent monitoring')
  })

  it('keeps the prompt first on a monitoring compact row', () => {
    const agent = monitoringAgent()
    agent.entry.prompt = 'Run background checks'

    const markup = renderCompactAgentRow({ agent, now: 2000, onActivate: vi.fn() })

    expect(markup).toContain('title="Run background checks - Monitoring background tasks"')
    expect(markup).toMatch(
      /Run background checks<\/span><span[^>]*> - Monitoring background tasks<\/span>/
    )
    // The trailing label is what truncates away, so the dot must still name the state.
    expect(markup).toContain('aria-label="Monitoring background tasks"')
  })

  it('names the monitoring state once when the row has no prompt', () => {
    const agent = monitoringAgent()

    const markup = renderCompactAgentRow({ agent, now: 2000, onActivate: vi.fn() })

    expect(markup).toContain('title="Monitoring background tasks"')
    expect(markup).not.toContain(' - Monitoring background tasks')
  })

  it('hands the whole row to the send-target reason, and only then', () => {
    const agent = monitoringAgent()
    agent.entry.prompt = 'Run background checks'

    const disabled = renderCompactAgentRow({
      agent,
      now: 2000,
      onActivate: vi.fn(),
      sendTargetStatus: 'disabled',
      sendTargetDisabledReason: 'Agent needs permission'
    })

    // The dot sits inside the row, so its own state title would shadow the reason on hover.
    expect(orderedTitles(disabled)).toEqual(['Agent needs permission', 'Claude'])

    const eligible = renderCompactAgentRow({ agent, now: 2000, onActivate: vi.fn() })

    expect(orderedTitles(eligible)).toEqual([
      'Claude',
      'Run background checks - Monitoring background tasks'
    ])
    expect(eligible).toContain('data-slot="tooltip-trigger"')
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
