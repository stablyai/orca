// Upstream removed the AgentKanbanCard suite in its low-value test-inventory cleanup
// (#38238/#38137/#38030 batch). This file is kept solely as the regression pin for
// #37019 (#36854): an unread completed turn must tint as Needs You, not Done green.
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { i18n } from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentKanbanCard } from './AgentKanbanCard'

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
    statusUpdatedAt: 1_000,
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
  })

  it('tints an unread completed turn as Needs You rather than Done green', () => {
    const { container } = renderCard({
      card: card({ bucket: 'attention', dotState: 'done', unseen: true }),
      now: 2_000
    })
    const className = container.firstElementChild?.className ?? ''
    // Needs You wins the tint; displayState stays 'done' so the green check dot still reports the outcome.
    expect(className).toContain('border-agent-question/40')
    expect(className).not.toContain('emerald')
  })
})
