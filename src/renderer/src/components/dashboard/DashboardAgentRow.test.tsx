import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

const NOW = 120_000

function makeAgent(
  overrides: Partial<DashboardAgentRowData> = {},
  entryOverrides: Partial<AgentStatusEntry> = {}
): DashboardAgentRowData {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: 'Fix hover scope',
    updatedAt: 60_000,
    stateStartedAt: 60_000,
    agentType: 'codex',
    paneKey,
    stateHistory: [],
    ...entryOverrides
  }

  return {
    paneKey,
    entry,
    tab,
    agentType: entry.agentType ?? 'codex',
    state: entry.state,
    startedAt: entry.stateStartedAt,
    ...overrides
  }
}

function renderRow(agent: DashboardAgentRowData): string {
  return renderToStaticMarkup(
    <DashboardAgentRow
      agent={agent}
      onDismiss={vi.fn()}
      onActivate={vi.fn()}
      now={NOW}
      hideIdentityIcon
      hideExpand
    />
  )
}

function classAttributes(markup: string): string[] {
  return Array.from(markup.matchAll(/class="([^"]*)"/g), (match) => match[1])
}

function classTokens(markup: string): string[] {
  return classAttributes(markup).flatMap((className) => className.split(/\s+/).filter(Boolean))
}

function hoverSwapClasses(markup: string): string[] {
  return classAttributes(markup).filter(
    (className) =>
      className.includes('group-hover') || className.includes('focus-visible:opacity-100')
  )
}

function dismissButtonClass(markup: string): string {
  const match = markup.match(/<button\b(?=[^>]*aria-label="Dismiss agent")[^>]*class="([^"]*)"/)
  if (!match) {
    throw new Error('Expected dismiss agent button in rendered markup')
  }
  return match[1]
}

function dismissButtonClassTokens(markup: string): string[] {
  return dismissButtonClass(markup).split(/\s+/).filter(Boolean)
}

function tokenCount(markup: string, token: string): number {
  return classTokens(markup).filter((classToken) => classToken === token).length
}

describe('DashboardAgentRow', () => {
  it('scopes the timestamp and dismiss hover swap to the row-owned group', () => {
    const markup = renderRow(makeAgent())
    const classes = hoverSwapClasses(markup)
    const tokens = classTokens(markup)

    expect(tokens).toContain('group/agent-row')
    expect(tokens).toContain('group-hover/agent-row:opacity-0')
    expect(dismissButtonClassTokens(markup)).toContain('group-hover/agent-row:opacity-100')
    expect(dismissButtonClassTokens(markup)).toContain('focus-visible:opacity-100')
    expect(classes.every((className) => !/\bgroup-hover:/.test(className))).toBe(true)
  })

  it('uses the row-owned group for the standalone dismiss control without timestamps', () => {
    const markup = renderRow(
      makeAgent({ startedAt: 0 }, { updatedAt: 0, stateStartedAt: 0, stateHistory: [] })
    )
    const classes = hoverSwapClasses(markup)

    expect(dismissButtonClassTokens(markup)).toContain('group-hover/agent-row:opacity-100')
    expect(dismissButtonClassTokens(markup)).toContain('focus-visible:opacity-100')
    expect(classes.every((className) => !/\bgroup-hover:/.test(className))).toBe(true)
  })

  it('keeps each row hover boundary inside an anonymous ancestor group', () => {
    const markup = renderToStaticMarkup(
      <div className="group">
        <DashboardAgentRow
          agent={makeAgent({ paneKey: 'tab-1:leaf-1' })}
          onDismiss={vi.fn()}
          onActivate={vi.fn()}
          now={NOW}
          hideIdentityIcon
          hideExpand
        />
        <DashboardAgentRow
          agent={makeAgent({ paneKey: 'tab-1:leaf-2' })}
          onDismiss={vi.fn()}
          onActivate={vi.fn()}
          now={NOW}
          hideIdentityIcon
          hideExpand
        />
      </div>
    )
    const classes = hoverSwapClasses(markup)

    expect(markup).toContain('class="group"')
    expect(tokenCount(markup, 'group/agent-row')).toBe(2)
    expect(tokenCount(markup, 'group-hover/agent-row:opacity-100')).toBe(2)
    expect(tokenCount(markup, 'group-hover/agent-row:opacity-0')).toBe(2)
    expect(classes.every((className) => !/\bgroup-hover:/.test(className))).toBe(true)
  })
})
