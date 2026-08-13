// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { i18n } from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentKanbanCard } from './AgentKanbanCard'

const agentIconRender = vi.fn()

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => {
    agentIconRender()
    return <span data-testid="agent-icon" />
  }
}))

vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: () => <span data-testid="state-dot" />
}))

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab:leaf',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Review the change',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab',
    leafId: 'leaf',
    repoName: 'Orca',
    worktreeName: 'dashboard-review',
    startedAt: 1_000,
    finishedAt: null,
    stateChangedAt: 1_000,
    unseen: false,
    ...overrides
  }
}

function renderCard(props: {
  card: DashboardCard
  now: number
  repoIcon?: RepoIcon | null
  onOpenTerminal?: () => void
}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <AgentKanbanCard
        card={props.card}
        repoIcon={props.repoIcon}
        now={props.now}
        onOpenTerminal={props.onOpenTerminal ?? vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('AgentKanbanCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not render an invented age when the start time is unknown', () => {
    renderCard({ card: card({ startedAt: 0 }), now: 2_000_000_000 })

    expect(screen.queryByText(/\d+d/)).not.toBeInTheDocument()
  })

  it('shows the question glyph once when a summary is available', () => {
    const attentionCard = card({
      bucket: 'attention',
      dotState: 'waiting',
      askSummary: 'Approve deploy?'
    })
    const { container, rerender } = renderCard({ card: attentionCard, now: 2_000 })

    expect(screen.queryByTestId('state-dot')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.lucide-message-circle-question-mark')).toHaveLength(1)

    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...attentionCard, askSummary: undefined }}
          now={2_000}
          onOpenTerminal={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.getByTestId('state-dot')).toBeInTheDocument()
    expect(container.querySelector('.lucide-message-circle-question-mark')).toBeNull()
  })

  it('shows the saved SSH host beside the repository metadata', () => {
    const { container } = renderCard({
      card: card({
        hostKind: 'ssh',
        executionHostId: 'ssh:opaque-target',
        hostLabel: 'openclaw'
      }),
      now: 2_000
    })

    expect(screen.getByLabelText('SSH host · openclaw')).toHaveAttribute(
      'data-dashboard-host-badge',
      'ssh'
    )
    expect(container.querySelector('.lucide-server')).toBeInTheDocument()
  })

  it('shows review metadata and expands grouped subagents without opening the terminal', () => {
    const onOpenTerminal = vi.fn()
    renderCard({
      card: card({
        review: { number: 11012, state: 'open' },
        subagents: [
          { id: 'child-1', name: 'Review loop', dotState: 'working' },
          { id: 'child-2', name: 'Smoke tests', dotState: 'done' }
        ]
      }),
      now: 2_000,
      onOpenTerminal
    })

    expect(screen.getByText('#11012')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Open review #11012' })).toBeInTheDocument()
    expect(screen.queryByText('Review loop')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    expect(screen.getByText('Review loop')).toBeInTheDocument()
    expect(screen.getByText('Smoke tests')).toBeInTheDocument()
    expect(onOpenTerminal).not.toHaveBeenCalled()
  })

  it('opens the terminal from the footer while keeping subagent disclosure isolated', () => {
    const onOpenTerminal = vi.fn()
    renderCard({
      card: card({
        conversationName: 'Dashboard review',
        review: { number: 11042, state: 'open' },
        subagents: [{ id: 'child-1', name: 'Review loop', dotState: 'working' }]
      }),
      now: 61_000,
      onOpenTerminal
    })

    fireEvent.click(screen.getByText('#11042'))
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '1 subagent' }))
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it('labels one subagent accessibly and never renders a workspace-status dot', () => {
    renderCard({
      card: card({
        workspaceStatusId: 'in-review',
        workspaceStatusLabel: 'In review',
        workspaceStatusColor: 'emerald',
        subagents: [{ id: 'child-1', name: 'Review loop', dotState: 'working' }]
      }),
      now: 2_000
    })

    expect(screen.getByRole('button', { name: '1 subagent' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'In review' })).not.toBeInTheDocument()
  })

  it('tints unseen Done green and keeps acknowledged Done neutral as Idle', () => {
    const { container: attention } = renderCard({
      card: card({ bucket: 'attention', dotState: 'waiting' }),
      now: 2_000
    })
    expect(attention.firstElementChild?.className).toContain('border-amber-500/40')

    cleanup()
    const { container: done } = renderCard({
      card: card({ bucket: 'done', dotState: 'done', unseen: true }),
      now: 2_000
    })
    expect(done.firstElementChild?.className).toContain('border-emerald-500/40')

    cleanup()
    const { container: idle } = renderCard({
      card: card({ bucket: 'idle', dotState: 'done', unseen: false }),
      now: 2_000
    })
    const idleClassName = idle.firstElementChild?.className ?? ''
    expect(idleClassName).toContain('border-border/60')
    expect(idleClassName).not.toContain('emerald')
    expect(idleClassName).not.toContain('amber')
  })

  it('heads the card with the conversation name and drops the worktree to the footer', () => {
    const { container } = renderCard({
      card: card({ lastUserMessage: 'ship it', conversationName: 'Sparse-checkout parser' }),
      now: 2_000
    })

    const cardElement = container.firstElementChild!
    const header = cardElement.querySelector('button')!.firstElementChild!
    const footer = cardElement.lastElementChild!
    expect(header).toHaveTextContent('Sparse-checkout parser')
    expect(header).not.toHaveTextContent('dashboard-review')
    expect(footer).toHaveTextContent('dashboard-review')
    // The message line is attributed to the user again — the name moved up.
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('heads the card with the worktree when no name resolves, without repeating it', () => {
    const { container } = renderCard({ card: card({ lastUserMessage: 'ship it' }), now: 2_000 })

    expect(screen.getAllByText('dashboard-review')).toHaveLength(1)
    expect(container.querySelector('button')!.firstElementChild).toHaveTextContent(
      'dashboard-review'
    )
  })

  it('shows the repo as an icon labelled with its name instead of inline text', () => {
    renderCard({
      card: card(),
      now: 2_000,
      repoIcon: { type: 'emoji', emoji: '🐳' }
    })

    expect(screen.getByLabelText('Orca')).toBeInTheDocument()
    expect(screen.getByText('🐳')).toBeInTheDocument()
  })

  it('skips structured-clone rerenders until visible card data or its age changes', () => {
    const onOpenTerminal = vi.fn()
    const initial = card({
      startedAt: 1_000,
      subagents: [{ id: 'child-1', name: 'Review loop', dotState: 'working' }]
    })
    const repoIcon: RepoIcon = { type: 'lucide', name: 'Rocket' }
    const { rerender } = render(
      <TooltipProvider>
        <AgentKanbanCard
          card={initial}
          repoIcon={repoIcon}
          now={61_500}
          onOpenTerminal={onOpenTerminal}
        />
      </TooltipProvider>
    )
    expect(agentIconRender).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1m')).toBeInTheDocument()

    // A fresh structured clone of identical data — including the repo icon.
    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...initial, subagents: initial.subagents?.map((subagent) => ({ ...subagent })) }}
          repoIcon={{ ...repoIcon }}
          now={62_000}
          onOpenTerminal={onOpenTerminal}
        />
      </TooltipProvider>
    )
    expect(agentIconRender).toHaveBeenCalledTimes(1)

    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...initial, subagents: initial.subagents?.map((subagent) => ({ ...subagent })) }}
          repoIcon={{ ...repoIcon }}
          now={121_500}
          onOpenTerminal={onOpenTerminal}
        />
      </TooltipProvider>
    )
    expect(agentIconRender).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2m')).toBeInTheDocument()
  })

  it('rerenders when the repo icon changes', () => {
    const onOpenTerminal = vi.fn()
    const initial = card({ startedAt: 1_000 })
    const { rerender } = render(
      <TooltipProvider>
        <AgentKanbanCard
          card={initial}
          repoIcon={{ type: 'lucide', name: 'Rocket' }}
          now={61_500}
          onOpenTerminal={onOpenTerminal}
        />
      </TooltipProvider>
    )
    expect(agentIconRender).toHaveBeenCalledTimes(1)

    rerender(
      <TooltipProvider>
        <AgentKanbanCard
          card={{ ...initial }}
          repoIcon={{ type: 'lucide', name: 'Database' }}
          now={61_500}
          onOpenTerminal={onOpenTerminal}
        />
      </TooltipProvider>
    )
    expect(agentIconRender).toHaveBeenCalledTimes(2)
  })

  it('updates the relative age when the UI language changes', async () => {
    renderCard({ card: card({ startedAt: 1_000 }), now: 121_500 })
    expect(screen.getByText('2m')).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('ja')
    })

    expect(screen.getByText('2分')).toBeInTheDocument()
  })
})
