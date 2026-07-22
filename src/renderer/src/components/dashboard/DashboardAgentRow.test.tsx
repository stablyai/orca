import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
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

function renderSendTargetRow(
  props: Pick<
    ComponentProps<typeof DashboardAgentRow>,
    'sendTargetStatus' | 'sendTargetDisabledReason'
  >
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DashboardAgentRow
        agent={makeAgent()}
        onDismiss={vi.fn()}
        onActivate={vi.fn()}
        now={NOW}
        hideIdentityIcon
        hideExpand
        {...props}
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

function classTokensForTaggedElement(markup: string, dataAttribute: string): string[] {
  const tagMatch = markup.match(new RegExp(`<[^>]+${dataAttribute}[^>]*>`))
  if (!tagMatch) {
    throw new Error(`Expected tagged element for ${dataAttribute}`)
  }
  const classMatch = tagMatch[0].match(/class="([^"]*)"/)
  if (!classMatch) {
    throw new Error(`Expected class attribute for ${dataAttribute}`)
  }
  return classMatch[1].split(/\s+/).filter(Boolean)
}

describe('DashboardAgentRow', () => {
  it('renders orchestration task preview instead of the raw dispatch preamble prompt', () => {
    const markup = renderRow(
      makeAgent(
        {},
        {
          prompt: 'You are working inside Orca, a multi-agent IDE.',
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'ctx-1',
            taskTitle: 'Checkout race',
            displayName: 'Fix checkout race'
          }
        }
      )
    )

    expect(markup).toContain('Fix checkout race')
    expect(markup).not.toContain('You are working inside Orca')
  })

  it('shows the active model beside the agent label', () => {
    const markup = renderRow(makeAgent({}, { model: 'gpt-5.4-mini' }))

    expect(markup).toContain('title="gpt-5.4-mini"')
    expect(markup).toContain('>gpt-5.4-mini</span>')
    expect(classTokens(markup)).toContain('font-mono')
  })

  it('uses the hover background as the focused-pane row highlight', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <DashboardAgentRow
          agent={makeAgent()}
          onDismiss={vi.fn()}
          onActivate={vi.fn()}
          now={NOW}
          hideIdentityIcon
          hideExpand
          isFocusedPane
        />
      </TooltipProvider>
    )

    expect(markup).toContain('data-focused-agent-pane="true"')
    expect(classTokens(markup)).toContain('worktree-agent-row-hover')
  })

  it('marks eligible send-target rows with an inline send target button', () => {
    const markup = renderSendTargetRow({ sendTargetStatus: 'eligible' })
    const tokens = classTokens(markup)

    expect(markup).toContain('data-agent-send-target="eligible"')
    expect(tokens).not.toContain('worktree-agent-send-target')
    expect(tokens).not.toContain('ring-offset-sidebar')
    expect(tokens).toContain('worktree-agent-row-hover')
    expect(markup).toContain('aria-label="Send to this agent"')
    expect(tokens).toContain('worktree-agent-send-target-button')
    expect(tokens).toContain('absolute')
    expect(tokens).toContain('h-5')
    expect(tokens).toContain('w-12')
    expect(markup).toContain('lucide-send')
    expect(markup).not.toContain('aria-label="Dismiss agent"')
  })

  it('marks disabled send-target rows as muted without an eligibility ring', () => {
    const markup = renderSendTargetRow({
      sendTargetStatus: 'disabled',
      sendTargetDisabledReason: 'Terminal is no longer available'
    })
    const tokens = classTokens(markup)

    expect(markup).toContain('data-agent-send-target="disabled"')
    expect(markup).toContain('title="Terminal is no longer available • started 1m ago"')
    expect(tokens).toContain('cursor-default')
    expect(tokens).toContain('opacity-60')
    expect(tokens).not.toContain('worktree-agent-send-target')
    expect(tokens).not.toContain('ring-offset-sidebar')
    expect(markup).not.toContain('aria-label="Send to this agent"')
  })

  it('marks sending rows with a non-clickable progress treatment', () => {
    const markup = renderSendTargetRow({
      sendTargetStatus: 'sending',
      sendTargetDisabledReason: 'Sending...'
    })
    const tokens = classTokens(markup)

    expect(markup).toContain('data-agent-send-target="sending"')
    expect(markup).toContain('title="Sending... • started 1m ago"')
    expect(tokens).not.toContain('worktree-agent-send-target')
    expect(tokens).not.toContain('ring-offset-sidebar')
    expect(tokens).toContain('worktree-agent-send-target-button')
    expect(tokens).toContain('cursor-progress')
    expect(tokens).toContain('opacity-75')
    expect(markup).toContain('aria-label="Send to this agent"')
    expect(markup).toContain('disabled=""')
  })

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

  it('renders waiting rows with the amber permission color', () => {
    const markup = renderRow(makeAgent({}, { state: 'waiting' }))
    const tokens = classTokens(markup)

    expect(markup).toContain('aria-label="Waiting for input"')
    expect(tokens).toContain('bg-amber-500')
    expect(tokens).not.toContain('bg-red-500')
  })

  it('keeps blocked rows red', () => {
    const markup = renderRow(makeAgent({}, { state: 'blocked' }))
    const tokens = classTokens(markup)

    expect(markup).toContain('aria-label="Blocked"')
    expect(tokens).toContain('bg-red-500')
    expect(tokens).not.toContain('bg-amber-500')
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

  it('reserves a real working tool line before tool metadata arrives', () => {
    const emptyToolMarkup = renderRow(makeAgent())
    const activeToolMarkup = renderRow(
      makeAgent({}, { toolName: 'ListDir', toolInput: '/Users/nwparker/orca' })
    )

    // Why: Antigravity emits working hooks without tool metadata between
    // tool-specific hooks; a whitespace placeholder collapses and makes the
    // sidebar row jump from one secondary line to two.
    expect(emptyToolMarkup).toContain('data-agent-row-tool-slot=""')
    expect(activeToolMarkup).toContain('data-agent-row-tool-slot=""')
    expect(
      classTokensForTaggedElement(emptyToolMarkup, 'data-agent-row-tool-placeholder="true"')
    ).toContain('h-[1lh]')
    expect(
      classTokensForTaggedElement(activeToolMarkup, 'data-agent-row-tool-header="true"')
    ).toContain('h-[1lh]')
    expect(emptyToolMarkup).not.toContain('lucide-wrench')
    expect(activeToolMarkup).toContain('lucide-wrench')
    expect(activeToolMarkup).toContain('ListDir')
  })

  it('renders orchestration child rows with a connector and tree level', () => {
    const markup = renderRow(
      makeAgent({
        lineage: {
          depth: 1,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 0
        }
      })
    )

    expect(markup).toContain('data-agent-lineage-connector="last"')
    expect(markup).toContain('role="treeitem"')
    expect(markup).toContain('aria-level="2"')
    expect(classTokens(markup)).toContain('pl-5')
    expect(classTokens(markup)).toContain('left-[13px]')
    expect(classTokens(markup)).toContain('top-[0.7rem]')
    expect(classTokens(markup)).toContain('w-1.5')
    expect(classTokens(markup)).toContain('border-l-[1.5px]')
    expect(classTokens(markup)).toContain('border-t-[1.5px]')
    expect(classTokens(markup)).toContain('border-muted-foreground/45')
  })

  it('annotates parent identity icon when it dispatched children', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <DashboardAgentRow
          agent={makeAgent({
            lineage: {
              depth: 0,
              isFirstSibling: true,
              isLastSibling: true,
              childCount: 2
            }
          })}
          onDismiss={vi.fn()}
          onActivate={vi.fn()}
          now={NOW}
          hideExpand
        />
      </TooltipProvider>
    )

    expect(markup).toContain('title="Codex - dispatched 2 agents"')
    expect(markup).toContain('data-agent-lineage-parent-connector="true"')
    expect(classTokens(markup)).toContain('left-[13px]')
    expect(markup).toContain('aria-level="1"')
  })

  it('marks child-disclosure rows as lineage manager rows', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <DashboardAgentRow
          agent={makeAgent()}
          onDismiss={vi.fn()}
          onActivate={vi.fn()}
          now={NOW}
          hideIdentityIcon
          hideExpand
          childAgentCount={2}
          childAgentsExpanded={false}
          onToggleChildAgents={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(classTokens(markup)).toContain('worktree-agent-lineage-parent-row')
    expect(markup).toContain('aria-label="Show 2 child agents"')
  })
})
