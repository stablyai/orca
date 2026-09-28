import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow, getCompactAgentSecondary } from './worktree-card-compact-agent-row'
import { getAgentDotState, summarizeAgents } from './worktree-card-agent-summary'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

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

  it('keeps monitoring visible before a compact row prompt', () => {
    const agent = monitoringAgent()
    agent.entry.prompt = 'Run background checks'

    const markup = renderCompactAgentRow({ agent, now: 2000, onActivate: vi.fn() })

    expect(markup).toContain('title="Monitoring background tasks - Run background checks"')
    expect(markup).toMatch(
      /Monitoring background tasks<\/span><span[^>]*> - Run background checks<\/span>/
    )
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
      'Monitoring background tasks - Run background checks'
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

  it('lists a failed turn as failed, not done, ahead of an interrupted one', () => {
    const done = monitoringAgent()
    done.state = 'done'
    done.entry.state = 'done'
    done.entry.workingMode = undefined
    const failed = {
      ...done,
      paneKey: 'tab-1:leaf-3',
      entry: {
        ...done.entry,
        paneKey: 'tab-1:leaf-3',
        mainAgent: { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 1 }
      }
    }
    const interrupted = {
      ...done,
      paneKey: 'tab-1:leaf-2',
      entry: { ...done.entry, paneKey: 'tab-1:leaf-2', interrupted: true }
    }

    expect(getAgentDotState(failed)).toBe('failed')
    expect(getCompactAgentSecondary(failed, 0)).toBe('Failed')
    expect(getCompactAgentSecondary(interrupted, 0)).toBe('Interrupted by user')
    expect(summarizeAgents([done, interrupted, failed], 'Agents')).toBe(
      'Agents: 1 failed, 1 interrupted, 1 done'
    )
  })

  it('reads a main agent that failed while its subagent works as failed, ranked above working', () => {
    const held = (outcome: 'failure' | 'success' | 'cancellation'): DashboardAgentRowData => {
      const agent = monitoringAgent()
      agent.entry.workingMode = undefined
      agent.entry.mainAgent = { state: 'done', outcome, stateStartedAt: 1 }
      return agent
    }
    const working = monitoringAgent()
    working.paneKey = 'tab-1:leaf-2'
    working.entry = { ...working.entry, paneKey: 'tab-1:leaf-2', workingMode: undefined }

    expect(getAgentDotState(held('failure'))).toBe('failed')
    expect(getCompactAgentSecondary(held('failure'), 0)).toBe('Failed')
    expect(summarizeAgents([working, held('failure')], 'Agents')).toBe(
      'Agents: 1 failed, 1 working'
    )
    // Only a failure outranks live work; a success or a stop with a live subagent reads working.
    expect(getAgentDotState(held('success'))).toBe('working')
    expect(getAgentDotState(held('cancellation'))).toBe('working')
    expect(getCompactAgentSecondary(held('cancellation'), 0)).not.toBe('Interrupted by user')
  })

  it('keeps a subagent row on its own state while its failed main agent reads failed', () => {
    const parent = monitoringAgent()
    parent.entry = {
      ...parent.entry,
      workingMode: undefined,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 },
      subagents: [{ id: 'child-1', state: 'working', startedAt: 1 }]
    }
    const [child] = buildSubagentChildRows({
      parentEntry: parent.entry,
      tab: parent.tab,
      parentIsFresh: true
    })

    expect(getAgentDotState(parent)).toBe('failed')
    expect(getAgentDotState(child)).toBe('working')
  })
})
