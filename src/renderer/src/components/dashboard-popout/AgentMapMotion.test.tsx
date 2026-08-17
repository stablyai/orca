// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentMap } from './AgentMap'
import { AGENT_MAP_ENTER_DURATION_MS, AGENT_MAP_EXIT_DURATION_MS } from './useAgentMapMotionLayout'

const NOW = 2_000_000_000

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Build map',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    conversationName: 'Agent alpha',
    startedAt: NOW - 60_000,
    finishedAt: null,
    stateChangedAt: NOW - 1_000,
    unseen: false,
    hostKind: 'local',
    workspaceKind: 'worktree',
    ...overrides
  }
}

describe('Agent Map motion lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({})
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps agent positioning separate from the animated hover visual', () => {
    render(<AgentMap cards={[card()]} now={NOW} onOpenTerminal={vi.fn()} />)

    const agent = screen.getByRole('button', { name: /Agent alpha/ })
    expect(agent).toHaveAttribute('transform', expect.stringMatching(/^translate\(/))
    expect(agent.querySelector(':scope > .agent-map-agent-visual')).toBeInTheDocument()
  })

  it('retains created and removed agents for anchored enter and exit motion', () => {
    const first = card()
    const added = card({
      paneKey: 'pane-2',
      ptyId: 'pty-2',
      tabId: 'tab-2',
      leafId: 'leaf-2',
      conversationName: 'Agent beta'
    })
    const view = render(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)

    vi.useFakeTimers()
    view.rerender(<AgentMap cards={[first, added]} now={NOW} onOpenTerminal={vi.fn()} />)
    const entering = screen.getByRole('button', { name: /Agent beta/ })
    const position = entering.getAttribute('transform')
    expect(entering).toHaveClass('is-entering')
    act(() => vi.advanceTimersByTime(AGENT_MAP_ENTER_DURATION_MS))
    expect(entering).not.toHaveClass('is-entering')

    view.rerender(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)
    const exiting = view.container.querySelector<SVGGElement>('[aria-label^="Agent beta,"]')
    expect(exiting).toHaveClass('is-exiting')
    expect(exiting).toHaveAttribute('transform', position)

    act(() => vi.advanceTimersByTime(AGENT_MAP_EXIT_DURATION_MS))
    expect(view.container.querySelector('[aria-label^="Agent beta,"]')).not.toBeInTheDocument()
  })

  it('retains removed worktrees until their exit transition completes', () => {
    const first = card()
    const second = card({
      paneKey: 'pane-2',
      ptyId: 'pty-2',
      tabId: 'tab-2',
      leafId: 'leaf-2',
      worktreeId: 'worktree-2',
      worktreeName: 'Motion branch',
      conversationName: 'Agent beta'
    })
    const view = render(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)

    vi.useFakeTimers()
    view.rerender(<AgentMap cards={[first, second]} now={NOW} onOpenTerminal={vi.fn()} />)
    const enteringGroup = view.container
      .querySelector('[aria-label="Open Motion branch worktree details"]')
      ?.closest('.agent-map-worktree-group')
    expect(enteringGroup).toHaveClass('is-entering')
    act(() => vi.advanceTimersByTime(AGENT_MAP_ENTER_DURATION_MS))
    expect(enteringGroup).not.toHaveClass('is-entering')

    view.rerender(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)
    const ring = view.container.querySelector<SVGCircleElement>(
      '[aria-label="Open Motion branch worktree details"]'
    )
    const exitingGroup = ring?.closest('.agent-map-worktree-group')
    const exitingAgent = exitingGroup?.querySelector('[data-agent-map-agent]')
    expect(exitingGroup).toHaveClass('is-exiting')
    expect(exitingGroup).toHaveAttribute('aria-hidden', 'true')
    expect(exitingAgent).toHaveAttribute('tabindex', '-1')
    expect(exitingAgent).toHaveAttribute('aria-hidden', 'true')

    act(() => vi.advanceTimersByTime(AGENT_MAP_EXIT_DURATION_MS))
    expect(
      view.container.querySelector('[aria-label="Open Motion branch worktree details"]')
    ).not.toBeInTheDocument()
  })

  it('does not restart an exit deadline for metadata-only layout updates', async () => {
    const first = card()
    const removed = card({ paneKey: 'pane-2', conversationName: 'Agent beta' })
    const view = render(<AgentMap cards={[first, removed]} now={NOW} onOpenTerminal={vi.fn()} />)

    vi.useFakeTimers()
    view.rerender(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)
    await act(async () => {
      vi.advanceTimersByTime(AGENT_MAP_EXIT_DURATION_MS - 10)
    })
    view.rerender(<AgentMap cards={[first]} now={NOW + 30_000} onOpenTerminal={vi.fn()} />)
    await act(async () => {
      vi.advanceTimersByTime(10)
    })

    expect(view.container.querySelector('[aria-label^="Agent beta,"]')).not.toBeInTheDocument()
  })

  it('commits a metadata-only layout update once', () => {
    let commitCount = 0
    const view = render(
      <Profiler id="agent-map" onRender={() => (commitCount += 1)}>
        <AgentMap cards={[card()]} now={NOW} onOpenTerminal={vi.fn()} />
      </Profiler>
    )
    commitCount = 0

    view.rerender(
      <Profiler id="agent-map" onRender={() => (commitCount += 1)}>
        <AgentMap cards={[card()]} now={NOW + 30_000} onOpenTerminal={vi.fn()} />
      </Profiler>
    )

    expect(commitCount).toBe(1)
  })

  it('makes descendants non-interactive while their project exits', () => {
    const first = card()
    const removed = card({
      paneKey: 'pane-2',
      repoId: 'repo-2',
      repoName: 'Removed project',
      worktreeId: 'worktree-2',
      worktreeName: 'Removed branch',
      conversationName: 'Agent beta'
    })
    const view = render(<AgentMap cards={[first, removed]} now={NOW} onOpenTerminal={vi.fn()} />)

    vi.useFakeTimers()
    view.rerender(<AgentMap cards={[first]} now={NOW} onOpenTerminal={vi.fn()} />)
    const exitingProject = view.container.querySelector('.agent-map-project-node.is-exiting')
    const exitingAgent = exitingProject?.querySelector('[data-agent-map-agent]')

    expect(exitingProject).toHaveAttribute('aria-hidden', 'true')
    expect(exitingAgent).toHaveAttribute('tabindex', '-1')
    expect(exitingAgent).toHaveAttribute('aria-hidden', 'true')
  })
})
