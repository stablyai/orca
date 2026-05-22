import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { TooltipProvider } from '../ui/tooltip'
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
    <TooltipProvider>
      <DashboardAgentRow
        agent={agent}
        onDismiss={vi.fn()}
        onActivate={vi.fn()}
        now={NOW}
        hideIdentityIcon
        hideExpand
      />
    </TooltipProvider>
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
      <TooltipProvider>
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
      </TooltipProvider>
    )
    const classes = hoverSwapClasses(markup)

    expect(markup).toContain('class="group"')
    expect(tokenCount(markup, 'group/agent-row')).toBe(2)
    expect(tokenCount(markup, 'group-hover/agent-row:opacity-100')).toBe(2)
    expect(tokenCount(markup, 'group-hover/agent-row:opacity-0')).toBe(2)
    expect(classes.every((className) => !/\bgroup-hover:/.test(className))).toBe(true)
  })

  it('renders interrupted done rows with plain text on the secondary line', () => {
    const markup = renderRow(
      makeAgent(
        { state: 'done', startedAt: 1_000 },
        {
          state: 'done',
          prompt: 'Give me a quick update',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          stateHistory: [{ state: 'working', prompt: 'Give me a quick update', startedAt: 1_000 }],
          interrupted: true
        }
      )
    )
    const promptIndex = markup.indexOf('Give me a quick update')
    const interruptedIndex = markup.indexOf('>interrupted<')

    // Why: interrupted keeps the leading red dot, but the plain text belongs
    // on the response line so it does not compete with the user's prompt.
    expect(markup).toContain('data-slot="tooltip-trigger"')
    expect(markup).toContain('aria-label="Interrupted by user"')
    expect(markup).toContain('bg-red-500')
    expect(markup).not.toContain('data-slot="badge"')
    expect(interruptedIndex).toBeGreaterThan(promptIndex)
    expect(markup).not.toContain('lucide-circle-check')
  })
})
