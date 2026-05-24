import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'

const mocks = vi.hoisted(() => ({
  status: 'inactive' as WorktreeStatus,
  isFocusedAgentPane: false
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: vi.fn(() => mocks.status)
}))

vi.mock('./focused-agent-status-highlight', () => ({
  useFocusedAgentStatusHighlight: vi.fn(() => mocks.isFocusedAgentPane)
}))

function renderMarkup(status: WorktreeStatus, isFocusedAgentPane = false): string {
  mocks.status = status
  mocks.isFocusedAgentPane = isFocusedAgentPane
  return renderToStaticMarkup(
    React.createElement(WorktreeActivityStatusIndicator, { worktreeId: 'wt-child' })
  )
}

describe('WorktreeActivityStatusIndicator', () => {
  beforeEach(() => {
    mocks.status = 'inactive'
    mocks.isFocusedAgentPane = false
  })

  it('renders the shared inactive status for slept worktrees', () => {
    const markup = renderMarkup('inactive')

    expect(markup).toContain('Inactive')
    expect(markup).toContain('bg-neutral-500/40')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('renders the shared active status when the worktree is live', () => {
    const markup = renderMarkup('active')

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
  })

  it('adds a blue focus halo when the active pane owns an agent status row', () => {
    const markup = renderMarkup('working', true)

    expect(markup).toContain('data-focused-agent-pane="true"')
    expect(markup).toContain('ring-[var(--terminal-pane-locate)]')
    expect(markup).toContain('Focused agent pane, Working')
  })
})
