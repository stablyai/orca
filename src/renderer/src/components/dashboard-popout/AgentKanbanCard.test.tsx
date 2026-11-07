// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentKanbanCard } from './AgentKanbanCard'

const agent: DashboardCard = {
  paneKey: 'pk-1',
  ptyId: 'p1',
  agentType: 'claude',
  bucket: 'working',
  dotState: 'working',
  task: 'task text',
  repoId: 'r1',
  worktreeId: 'w1',
  tabId: 'tab1',
  leafId: 'l1',
  repoName: 'Repo',
  worktreeName: 'wt-name',
  startedAt: 0,
  finishedAt: null,
  stateChangedAt: 0,
  unseen: false
}

function renderCard(): {
  onOpenTerminal: ReturnType<typeof vi.fn>
  onOpenWorktree: ReturnType<typeof vi.fn>
} {
  const onOpenTerminal = vi.fn()
  const onOpenWorktree = vi.fn()
  render(
    <TooltipProvider>
      <AgentKanbanCard
        card={agent}
        now={0}
        onOpenTerminal={onOpenTerminal}
        onOpenWorktree={onOpenWorktree}
      />
    </TooltipProvider>
  )
  return { onOpenTerminal, onOpenWorktree }
}

function headingButton(): HTMLElement {
  const button = screen.getByText('wt-name').closest('button')
  if (!button) {
    throw new Error('card heading button is missing')
  }
  return button
}

const previewModifier = navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true }

describe('AgentKanbanCard open gestures', () => {
  afterEach(() => {
    cleanup()
  })

  it('opens the worktree on a plain click without the preview', () => {
    const { onOpenTerminal, onOpenWorktree } = renderCard()
    fireEvent.click(headingButton(), { detail: 1 })
    expect(onOpenWorktree).toHaveBeenCalledWith(agent)
    expect(onOpenTerminal).not.toHaveBeenCalled()
  })

  it('opens the worktree once for a double click', () => {
    const { onOpenWorktree } = renderCard()
    fireEvent.click(headingButton(), { detail: 1 })
    fireEvent.click(headingButton(), { detail: 2 })
    expect(onOpenWorktree).toHaveBeenCalledTimes(1)
  })

  it('opens the worktree on keyboard activation', () => {
    const { onOpenTerminal, onOpenWorktree } = renderCard()
    fireEvent.click(headingButton(), { detail: 0 })
    expect(onOpenWorktree).toHaveBeenCalledWith(agent)
    expect(onOpenTerminal).not.toHaveBeenCalled()
  })

  it('opens the terminal preview on the platform modifier click', () => {
    const { onOpenTerminal, onOpenWorktree } = renderCard()
    fireEvent.click(headingButton(), { detail: 1, ...previewModifier })
    expect(onOpenTerminal).toHaveBeenCalledWith(agent)
    expect(onOpenWorktree).not.toHaveBeenCalled()
  })
})
