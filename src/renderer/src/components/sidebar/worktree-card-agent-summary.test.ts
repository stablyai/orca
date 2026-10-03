import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AcknowledgedAgentRow as DashboardAgentRowData } from '@/lib/agent-entry-acknowledgement'
import { CompactAgentRow, getCompactAgentSecondary } from './worktree-card-compact-agent-row'
import {
  buildSummaryAgentGroups,
  getAgentDotState,
  summarizeAgents
} from './worktree-card-agent-summary'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'
import { acknowledgedAgentRow } from '@/lib/agent-entry-acknowledgement'

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
      paneKey: 'tab-1:leaf-1',
      acknowledgedAt: undefined
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
  // The sidebar lists running children only, so a child row it counts is one that runs.
  it("counts a running child by its own row's state", () => {
    const running: DashboardAgentRowData = {
      ...monitoringAgent(),
      paneKey: 'tab-1:leaf-1\u0000subagent:child',
      rowSource: 'subagent',
      state: 'working',
      childRow: {
        id: 'child',
        kind: 'agent',
        displayState: 'waiting',
        name: 'Fuzz the tokenizer',
        detail: null,
        firstObservedAt: 1,
        recencyAt: 1,
        canStop: false,
        settled: false,
        owned: []
      }
    }
    expect(getAgentDotState(running)).toBe('waiting')
    expect(buildSummaryAgentGroups([running]).map((group) => group.state)).toEqual(['waiting'])
  })

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

  it("lists a crash-cut turn as failed and a user's Stop as interrupted, before clean completions", () => {
    const done = monitoringAgent()
    done.state = 'done'
    done.entry.state = 'done'
    done.entry.workingMode = undefined
    const interrupted = {
      ...done,
      paneKey: 'tab-1:leaf-2',
      entry: {
        ...done.entry,
        paneKey: 'tab-1:leaf-2',
        mainAgent: { state: 'done' as const, outcome: 'interruption' as const, stateStartedAt: 1 }
      }
    }
    const stopped = {
      ...done,
      paneKey: 'tab-1:leaf-3',
      entry: { ...done.entry, paneKey: 'tab-1:leaf-3', interrupted: true }
    }

    expect(getAgentDotState(interrupted)).toBe('failed')
    expect(getCompactAgentSecondary(interrupted, 0)).toBe('Failed')
    expect(getAgentDotState(stopped)).toBe('interrupted')
    expect(getCompactAgentSecondary(stopped, 0)).toBe('Interrupted by user')
    const replaced = {
      ...done,
      entry: {
        ...done.entry,
        mainAgent: { state: 'done' as const, outcome: 'superseded' as const, stateStartedAt: 1 }
      }
    }
    expect(getAgentDotState(replaced)).toBe('interrupted')
    expect(getCompactAgentSecondary(replaced, 0)).toBe('Interrupted')
    expect(summarizeAgents([done, interrupted, stopped], 'Agents')).toBe(
      'Agents: 1 failed, 1 interrupted, 1 done'
    )
  })

  it("lists a failed turn as failed, not done, ahead of a user's Stop", () => {
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
      entry: {
        ...done.entry,
        paneKey: 'tab-1:leaf-2',
        mainAgent: { state: 'done' as const, outcome: 'cancellation' as const, stateStartedAt: 1 }
      }
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
    expect(getAgentDotState(acknowledgedAgentRow(child, undefined))).toBe('working')
  })

  // The row's own acknowledgement, the one that un-bolds it: once visited, the cut-short row reads
  // like a finished one, here and in the compact summary; a failure stays failed.
  it('reads a cut-short row failed only until the user visits it', () => {
    const done = monitoringAgent()
    done.state = 'done'
    done.entry = {
      ...done.entry,
      state: 'done',
      workingMode: undefined,
      lastAssistantMessage: 'Halfway through the loop'
    }
    const withVerdict = (
      outcome: 'interruption' | 'failure',
      acknowledgedAt: number | undefined
    ): DashboardAgentRowData => ({
      ...done,
      paneKey: `tab-1:${outcome}`,
      entry: {
        ...done.entry,
        mainAgent: { state: 'done', outcome, stateStartedAt: 1 },
        acknowledgedAt
      }
    })

    expect(getAgentDotState(withVerdict('interruption', 0))).toBe('failed')
    expect(getAgentDotState(withVerdict('interruption', 1))).toBe('done')
    expect(getAgentDotState(withVerdict('failure', 1))).toBe('failed')
    expect(getCompactAgentSecondary(withVerdict('interruption', 1), 0)).toBe(
      'Halfway through the loop'
    )
    expect(
      summarizeAgents([withVerdict('interruption', 1), withVerdict('failure', 1)], 'Agents')
    ).toBe('Agents: 1 failed, 1 done')
    const markup = (acknowledgedAt: number | undefined) =>
      renderCompactAgentRow({
        agent: withVerdict('interruption', acknowledgedAt),
        now: 0,
        onActivate: vi.fn()
      })
    expect(markup(undefined)).toContain('Failed')
    expect(markup(1)).not.toContain('Failed')
    expect(markup(1)).toContain('Halfway through the loop')
  })
})
