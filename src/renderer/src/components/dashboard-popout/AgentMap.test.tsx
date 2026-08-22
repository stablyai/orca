// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentMap } from './AgentMap'
import { agentMapAttentionMarkerScale } from './agent-map-node-presentation'
import type { AgentMapState } from './agent-map-filter'
import type { DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { AGENT_MAP_AGENT_RADIUS } from './agent-map-layout'
import { card, installAgentMapEnvironment, NOW, renderMap } from './agent-map-render-test-harness'

describe('AgentMap', () => {
  const environment = installAgentMapEnvironment()

  it('renders the amber marker only for unread agents', () => {
    const finished = card({
      paneKey: 'done',
      conversationName: 'Finished agent',
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 60_000,
      unseen: true
    })
    renderMap([card(), finished])

    const workingNode = screen.getByRole('button', { name: /Agent alpha/ })
    const doneNode = screen.getByRole('button', { name: /Finished agent/ })
    expect(workingNode).toHaveClass('fleet-status-working')
    expect(doneNode).toHaveClass('fleet-status-done')
    expect(workingNode.querySelector('.agent-map-agent-icon svg')).toBeInTheDocument()
    expect(workingNode.querySelector('[data-agent-unread-marker]')).not.toBeInTheDocument()
    expect(doneNode.querySelector('.agent-map-agent-icon svg')).toBeInTheDocument()
    const unreadMarker = doneNode.querySelector('[data-agent-unread-marker]')
    expect(unreadMarker).toHaveClass('agent-map-agent-unread-mark')
    // On the ring circumference at the top-left diagonal, where the halo breaks the ring.
    const onRing = String(-AGENT_MAP_AGENT_RADIUS * Math.SQRT1_2)
    expect(unreadMarker).toHaveAttribute('cx', onRing)
    expect(unreadMarker).toHaveAttribute('cy', onRing)
    expect(Number(unreadMarker?.getAttribute('r'))).toBeGreaterThanOrEqual(
      AGENT_MAP_AGENT_RADIUS * 0.225
    )
    expect(unreadMarker).toHaveAttribute('vector-effect', 'none')
    expect(doneNode).toHaveAccessibleName(/unread/)
  })

  it('lets attention override working on the worktree glow', () => {
    const done = card({
      paneKey: 'done',
      conversationName: 'Finished agent',
      worktreeId: 'worktree-done',
      worktreeName: 'Finished worktree',
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 60_000
    })
    const waiting = card({
      paneKey: 'waiting',
      conversationName: 'Question agent',
      bucket: 'attention',
      dotState: 'waiting'
    })
    const { container } = renderMap([card(), waiting, done])

    const workingNode = screen.getByRole('button', { name: /Agent alpha/ })
    const waitingNode = screen.getByRole('button', { name: /Question agent/ })
    const doneNode = screen.getByRole('button', { name: /Finished agent/ })
    const workingRing = screen.getByRole('button', {
      name: /Open Agent map worktree details/
    })
    const doneRing = screen.getByRole('button', {
      name: /Open Finished worktree worktree details/
    })

    expect(workingNode.querySelector('[data-agent-map-agent-status-glow]')).toHaveAttribute(
      'data-agent-active-status',
      'working'
    )
    expect(waitingNode.querySelector('[data-agent-map-agent-status-glow]')).toHaveAttribute(
      'data-agent-active-status',
      'waiting'
    )
    expect(doneNode.querySelector('[data-agent-map-agent-status-glow]')).not.toBeInTheDocument()
    expect(workingRing).toHaveClass('is-waiting')
    expect(workingRing).not.toHaveClass('is-working')
    expect(doneRing).not.toHaveClass('is-working')
    expect(container.querySelector('[data-agent-map-worktree-status-glow]')).toHaveAttribute(
      'data-worktree-active-status',
      'waiting'
    )
    expect(container.querySelectorAll('[data-agent-map-worktree-status-glow]')).toHaveLength(1)
  })

  it('keeps glow markup bounded for a large visible worktree', () => {
    const cards = Array.from({ length: 120 }, (_, index) => {
      const working = index % 2 === 0
      return card({
        paneKey: `pane-${index}`,
        ptyId: `pty-${index}`,
        tabId: `tab-${index}`,
        leafId: `leaf-${index}`,
        conversationName: `Agent ${index}`,
        bucket: working ? 'working' : 'done',
        dotState: working ? 'working' : 'done',
        finishedAt: working ? null : NOW - 60_000
      })
    })
    const { container } = renderMap(cards, { selectedPaneKey: 'pane-0' })

    expect(container.querySelectorAll('[data-agent-map-agent-status-glow]')).toHaveLength(60)
    expect(container.querySelectorAll('[data-agent-map-worktree-status-glow]')).toHaveLength(1)
    expect(container.querySelectorAll('filter')).toHaveLength(0)
  })

  it('enlarges unread markers when the full fleet is zoomed out', () => {
    const fleet = Array.from({ length: 72 }, (_, index) =>
      card({
        paneKey: `pane-${index}`,
        ptyId: `pty-${index}`,
        tabId: `tab-${index}`,
        leafId: `leaf-${index}`,
        worktreeId: `worktree-${index}`,
        worktreeName: `Worktree ${index}`,
        conversationName: `Agent ${index}`,
        unseen: index === 0
      })
    )
    const { container } = renderMap(fleet)
    const marker = container.querySelector<SVGCircleElement>('[data-agent-unread-marker]')!
    const agentMark =
      marker.parentElement!.querySelector<SVGCircleElement>('.agent-map-agent-mark')!

    expect(Number(marker.getAttribute('r'))).toBeGreaterThan(
      Number(agentMark.getAttribute('r')) * 0.225
    )
    expect(marker).toHaveAttribute('vector-effect', 'none')
  })

  it('grows attention markers more gently than the inverse zoom while keeping a size floor', () => {
    const mapScale = 0.2
    const markerScale = agentMapAttentionMarkerScale(mapScale)

    expect(markerScale).toBeGreaterThan(1)
    expect(markerScale).toBeLessThan(1 / mapScale)
    expect(AGENT_MAP_AGENT_RADIUS * 0.225 * markerScale * mapScale).toBeGreaterThanOrEqual(2.25)
  })

  it('shows worktree details and opens a running agent', () => {
    const onOpenTerminal = vi.fn()
    const running = card()
    renderMap([running], { onOpenTerminal })
    const ring = screen.getByRole('button', { name: 'Open Agent map worktree details' })
    fireEvent.click(ring)

    expect(ring).toHaveClass('is-open')
    expect(screen.queryByRole('button', { name: 'Focus ring' })).not.toBeInTheDocument()
    // The popover names the project; the map itself draws it uppercased.
    expect(screen.getByText('Orca')).toBeInTheDocument()
    expect(screen.getByText('1 agent · 1 active · 0 done')).toBeInTheDocument()
    expect(screen.getByText('Agent alpha')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /Agent alpha/ })[1])
    expect(onOpenTerminal).toHaveBeenCalledWith(running)
    expect(ring).not.toHaveClass('is-open')
  })

  it('counts acknowledged completions as done in worktree details', () => {
    renderMap([
      card({
        bucket: 'idle',
        dotState: 'done',
        unseen: false,
        finishedAt: NOW - 60_000
      })
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent map worktree details' }))

    expect(screen.getByText('1 agent · 0 active · 1 done')).toBeInTheDocument()
  })

  it('starts a new agent from the worktree details picker', () => {
    const onSpawnAgent = vi.fn()
    renderMap([card()], {
      onSpawnAgent,
      launchableAgentsByWorktreeId: { 'worktree-1': ['claude', 'codex'] }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent map worktree details' }))

    expect(screen.getByText('Start a new agent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))

    // The raw worktree id, not the host-qualified map identity.
    expect(onSpawnAgent).toHaveBeenCalledWith({ worktreeId: 'worktree-1', agent: 'codex' })
  })

  it('explains an empty picker rather than offering nothing', () => {
    renderMap([card()], { onSpawnAgent: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent map worktree details' }))

    expect(screen.getByText('No enabled agents detected.')).toBeInTheDocument()
  })

  it('offers sleep and launch on right-click where the store menu is unavailable', async () => {
    const onSleepWorkspace = vi.fn()
    renderMap([card()], {
      onSleepWorkspace,
      onSpawnAgent: vi.fn(),
      launchableAgentsByWorktreeId: { 'worktree-1': ['claude'] }
    })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Agent map worktree details' }), {
      clientX: 10,
      clientY: 10
    })

    expect(await screen.findByText('Start a new agent')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Sleep'))
    expect(onSleepWorkspace).toHaveBeenCalledWith({ worktreeId: 'worktree-1' })
  })

  it('toggles worktree details from the keyboard', () => {
    renderMap([card()])
    const ring = screen.getByRole('button', { name: 'Open Agent map worktree details' })

    fireEvent.keyDown(ring, { key: 'Enter' })
    expect(ring).toHaveClass('is-open')
    fireEvent.keyDown(ring, { key: 'Enter' })
    expect(ring).not.toHaveClass('is-open')
  })

  it('labels folder workspaces without presenting them as worktrees', () => {
    renderMap([card({ workspaceKind: 'folder', worktreeName: 'Documentation' })])

    expect(
      screen.getByRole('button', { name: 'Open Documentation folder workspace details' })
    ).toBeInTheDocument()
  })

  it('connects spawned workers beneath their visible parent', () => {
    const parent = card({ paneKey: 'parent', conversationName: 'Coordinator' })
    const child = card({
      paneKey: 'child',
      parentPaneKey: 'parent',
      conversationName: 'Worker'
    })
    const nested = card({
      paneKey: 'nested',
      parentPaneKey: 'child',
      conversationName: 'Subagent'
    })
    const orphan = card({
      paneKey: 'orphan',
      parentPaneKey: 'filtered-parent',
      conversationName: 'Orphaned worker'
    })
    const { container } = renderMap([parent, child, nested, orphan])
    const workerLink = container.querySelector('[data-child-pane-key="child"]')
    const nestedLink = container.querySelector('[data-child-pane-key="nested"]')

    expect(screen.getByRole('button', { name: /Coordinator/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Worker/ })).toBeInTheDocument()
    expect(container.querySelectorAll('[data-agent-map-lineage-link]')).toHaveLength(2)
    expect(workerLink).toHaveClass('agent-map-lineage-link')
    expect(workerLink).toHaveAttribute('data-agent-map-lineage-relation', 'orchestration')
    expect(workerLink).toHaveAttribute('data-parent-pane-key', 'parent')
    expect(workerLink?.getAttribute('d')?.match(/\bM\b/g)?.length).toBeGreaterThan(1)
    // Why orchestration, not subagent: `nested` is a card, and in-process subagents
    // never become cards — so a grandchild dispatch is still an orchestration edge.
    expect(nestedLink).toHaveClass('agent-map-lineage-link')
    expect(nestedLink).toHaveAttribute('data-agent-map-lineage-relation', 'orchestration')
    expect(nestedLink).toHaveAttribute('data-parent-pane-key', 'child')
    expect(nestedLink?.getAttribute('d')?.match(/\bM\b/g)?.length).toBeGreaterThan(1)
  })

  it('connects spawned workers across worktree rings', () => {
    const parent = card({
      paneKey: 'parent',
      worktreeId: 'parent-worktree',
      worktreeName: 'Parent workspace',
      conversationName: 'Coordinator'
    })
    const child = card({
      paneKey: 'child',
      worktreeId: 'child-worktree',
      worktreeName: 'Child workspace',
      parentPaneKey: 'parent',
      conversationName: 'Worker'
    })
    const nested = card({
      paneKey: 'nested',
      worktreeId: 'nested-worktree',
      worktreeName: 'Nested workspace',
      parentPaneKey: 'child',
      conversationName: 'Subagent'
    })
    const { container } = renderMap([parent, child, nested])
    const workerLink = container.querySelector('[data-child-pane-key="child"]')
    const nestedLink = container.querySelector('[data-child-pane-key="nested"]')

    expect(workerLink).toHaveClass('agent-map-lineage-link', 'is-cross-worktree')
    expect(workerLink).toHaveAttribute('data-agent-map-lineage-relation', 'orchestration')
    expect(nestedLink).toHaveClass('agent-map-lineage-link', 'is-cross-worktree')
    expect(nestedLink).toHaveAttribute('data-agent-map-lineage-relation', 'orchestration')
  })

  it('keeps lineage styling to one lightweight path per relationship at fleet scale', () => {
    const cards = Array.from({ length: 240 }, (_, index) =>
      card({
        paneKey: `agent-${index}`,
        parentPaneKey: index === 0 ? undefined : `agent-${index - 1}`,
        conversationName: `Agent ${index}`
      })
    )
    const { container } = renderMap(cards, { selectedPaneKey: 'agent-0' })

    expect(container.querySelectorAll('[data-agent-map-lineage-link]')).toHaveLength(239)
    expect(
      container.querySelectorAll('[data-agent-map-lineage-relation="orchestration"]')
    ).toHaveLength(239)
    expect(container.querySelectorAll('[data-agent-map-lineage-relation="subagent"]')).toHaveLength(
      0
    )
    expect(container.querySelectorAll('filter, animate, animateTransform')).toHaveLength(0)
  })

  it('hides orchestration links when the filter turns them off, keeping the agents', () => {
    const sameWorktree = [
      card({ paneKey: 'parent', conversationName: 'Coordinator' }),
      card({ paneKey: 'child', parentPaneKey: 'parent', conversationName: 'Worker' })
    ]
    const crossWorktree = [
      card({ paneKey: 'far-parent', worktreeId: 'wt-a', worktreeName: 'A' }),
      card({
        paneKey: 'far-child',
        worktreeId: 'wt-b',
        worktreeName: 'B',
        parentPaneKey: 'far-parent'
      })
    ]
    const cards = [...sameWorktree, ...crossWorktree]

    const shown = renderMap(cards)
    expect(shown.container.querySelectorAll('[data-agent-map-lineage-link]')).toHaveLength(2)
    cleanup()

    const hidden = renderMap(cards, { showOrchestrationLinks: false })
    // Both same-worktree and cross-worktree edges go; the nodes themselves stay.
    expect(hidden.container.querySelectorAll('[data-agent-map-lineage-link]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /Coordinator/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Worker/ })).toBeInTheDocument()
  })

  it('draws no lineage edge for an agent that lists itself as its own parent', () => {
    const { container } = renderMap([
      card({ paneKey: 'self', parentPaneKey: 'self', conversationName: 'Self parent' }),
      card({ paneKey: 'other', conversationName: 'Unrelated' })
    ])

    expect(container.querySelectorAll('[data-agent-map-lineage-link]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /Self parent/ })).toBeInTheDocument()
  })

  it('connects lineage between visible nodes even when the child is not ranked below its parent', () => {
    // A 2-cycle cannot be ranked consistently, so the bounded layout (>256 agents)
    // must place one of its edges pointing upward. Both nodes are drawn, so both
    // edges must be too — the old y-ordering gate silently dropped the upward one.
    const cards = [
      card({ paneKey: 'cycle-a', parentPaneKey: 'cycle-b', conversationName: 'Cycle A' }),
      card({ paneKey: 'cycle-b', parentPaneKey: 'cycle-a', conversationName: 'Cycle B' }),
      ...Array.from({ length: 255 }, (_, index) =>
        card({
          paneKey: `filler-${index}`,
          parentPaneKey: index === 0 ? undefined : `filler-${index - 1}`,
          conversationName: `Filler ${index}`
        })
      )
    ]
    const { container } = renderMap(cards, { selectedPaneKey: 'cycle-a' })

    expect(container.querySelector('[data-child-pane-key="cycle-a"]')).not.toBeNull()
    expect(container.querySelector('[data-child-pane-key="cycle-b"]')).not.toBeNull()
  })

  it('connects visible child worktrees beneath their parent ring', () => {
    const { container } = renderMap([
      card({ paneKey: 'parent', worktreeId: 'parent-worktree', worktreeName: 'Parent' }),
      card({
        paneKey: 'child',
        worktreeId: 'child-worktree',
        worktreeName: 'Child',
        parentWorktreeId: 'parent-worktree'
      }),
      card({
        paneKey: 'orphan',
        worktreeId: 'orphan-worktree',
        worktreeName: 'Orphan',
        parentWorktreeId: 'filtered-parent'
      })
    ])
    const links = container.querySelectorAll('[data-agent-map-worktree-lineage-link]')

    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('data-parent-worktree-id', 'parent-worktree')
    expect(links[0]).toHaveAttribute('data-child-worktree-id', 'child-worktree')
  })

  it('opens the shared dashboard terminal dialog when an agent is clicked', () => {
    const onOpenTerminal = vi.fn()
    const agent = card()
    renderMap([agent], { onOpenTerminal })

    fireEvent.click(screen.getByRole('button', { name: /Agent alpha/ }))
    expect(onOpenTerminal).toHaveBeenCalledWith(agent)
  })

  it('keeps a selected node visible while compacting around an adjacent terminal', () => {
    const { container } = renderMap([card()], { selectedPaneKey: 'pane-1' })

    const selectedNode = screen.getByRole('button', { name: /Agent alpha/ })
    expect(selectedNode).toHaveClass('is-selected')
    expect(screen.getByRole('button', { name: /Agent alpha/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const label = container.querySelector('.agent-map-worktree-label-group')!
    expect(selectedNode.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4)
    expect(label.querySelector('rect')).not.toBeInTheDocument()
    expect(screen.getByText('270%')).toBeInTheDocument()
    expect(screen.queryByText('Map filters')).not.toBeInTheDocument()
  })

  it('narrows the map to the enabled hosts', () => {
    render(
      <TooltipProvider>
        <AgentMap
          cards={[
            card({ paneKey: 'pane-local' }),
            card({
              paneKey: 'pane-ssh',
              worktreeId: 'worktree-2',
              worktreeName: 'Remote map',
              hostKind: 'ssh'
            })
          ]}
          now={NOW}
          enabledHosts={new Set<DashboardCardHostKind>(['ssh'])}
          onOpenTerminal={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(
      screen.queryByRole('button', { name: 'Open Agent map worktree details' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Remote map worktree details' })
    ).toBeInTheDocument()
  })

  it('eases the viewport into the selected agent', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const agent = card()
    const view = renderMap([agent])

    view.rerender(
      <AgentMap
        cards={[agent]}
        now={NOW}
        onOpenTerminal={vi.fn()}
        selectedPaneKey={agent.paneKey}
      />
    )
    act(() => frames.shift()?.(0))
    expect(screen.getByText('100%')).toBeInTheDocument()
    act(() => frames.shift()?.(120))
    expect(screen.getByText('249%')).toBeInTheDocument()
    act(() => frames.shift()?.(240))
    expect(screen.getByText('270%')).toBeInTheDocument()
  })

  it('keeps the selected node centered when topology changes around it', () => {
    const selected = card()
    const view = renderMap([selected], { selectedPaneKey: selected.paneKey })
    const svg = view.container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
    const selectedNode = (): SVGGElement =>
      view.container.querySelector<SVGGElement>('.agent-map-agent-node.is-selected')!
    const nodeCenter = (): [number, number] => {
      const match = selectedNode()
        .getAttribute('transform')
        ?.match(/translate\(([^ ]+) ([^)]+)\)/)
      return [Number(match?.[1]), Number(match?.[2])]
    }
    const viewportCenter = (): [number, number] => {
      const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
      return [x + width / 2, y + height / 2]
    }

    const originalNodeCenter = nodeCenter()
    view.rerender(
      <AgentMap
        cards={[
          card({
            paneKey: 'earlier-project',
            repoId: 'repo-0',
            repoName: 'Earlier',
            worktreeId: 'worktree-0'
          }),
          selected
        ]}
        now={NOW}
        onOpenTerminal={vi.fn()}
        selectedPaneKey={selected.paneKey}
      />
    )

    expect(nodeCenter()).not.toEqual(originalNodeCenter)
    expect(viewportCenter()[0]).toBeCloseTo(nodeCenter()[0])
    expect(viewportCenter()[1]).toBeCloseTo(nodeCenter()[1])
  })

  it('increases map label scale when users zoom out', () => {
    const { container } = renderMap([card()])
    const labelGroup = container.querySelector('.agent-map-worktree-label')?.parentElement
    const initialScale = Number(
      labelGroup?.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1]
    )

    const readsBeforeZoom = environment.boundsSpy.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))

    const zoomedScale = Number(
      labelGroup?.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1]
    )
    expect(environment.boundsSpy).toHaveBeenCalledTimes(readsBeforeZoom)
    expect(zoomedScale).toBeGreaterThan(initialScale)
  })

  it('avoids idle pointer layout reads and batches active viewport updates by frame', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { container } = renderMap([card()])
    const svg = container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
    Object.assign(svg, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    })

    const readsBeforeHover = environment.boundsSpy.mock.calls.length
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 20, clientY: 20 })
    expect(environment.boundsSpy).toHaveBeenCalledTimes(readsBeforeHover)

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 20, clientY: 20 })
    expect(svg.setPointerCapture).toHaveBeenCalledWith(1)
    const readsAfterPointerDown = environment.boundsSpy.mock.calls.length
    const initialViewBox = svg.getAttribute('viewBox')
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 30, clientY: 20 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 20 })

    expect(environment.boundsSpy).toHaveBeenCalledTimes(readsAfterPointerDown)
    expect(requestFrame).toHaveBeenCalledOnce()
    expect(svg).toHaveAttribute('viewBox', initialViewBox)

    act(() => frames.shift()?.(0))
    expect(svg.getAttribute('viewBox')).not.toBe(initialViewBox)

    requestFrame.mockClear()
    const readsBeforeWheel = environment.boundsSpy.mock.calls.length
    const wheel = (): void => {
      const event = new Event('wheel', { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        deltaY: { value: -10 },
        clientX: { value: 100 },
        clientY: { value: 100 }
      })
      fireEvent(svg, event)
      expect(event.defaultPrevented).toBe(true)
    }
    wheel()
    wheel()
    expect(environment.boundsSpy).toHaveBeenCalledTimes(readsBeforeWheel + 1)
    expect(requestFrame).toHaveBeenCalledOnce()
  })

  it('keeps active labels visible and progressively discloses quiet labels', () => {
    const quiet = card({
      paneKey: 'done',
      worktreeId: 'quiet-worktree',
      worktreeName: 'Quiet result',
      conversationName: 'Finished agent',
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 60_000,
      unseen: false
    })
    const { container } = renderMap([card(), quiet])
    const labels = [...container.querySelectorAll('.agent-map-worktree-label')]
    const activeGroup = labels.find((label) => label.textContent === 'Agent map')?.parentElement
    const quietGroup = labels.find((label) => label.textContent === 'Quiet result')?.parentElement

    expect(activeGroup).toHaveClass('is-visible')
    expect(quietGroup).not.toHaveClass('is-visible')
  })

  it('keeps acknowledged completions green and distinct from both unseen and idle', () => {
    const seenResult = card({
      paneKey: 'seen',
      conversationName: 'Seen result',
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 60_000,
      unseen: false
    })
    const newResult = card({
      paneKey: 'new',
      conversationName: 'New result',
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 2 * 60_000,
      unseen: true
    })
    renderMap([card(), seenResult, newResult])

    expect(screen.getByRole('button', { name: /Agent alpha/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New result/ })).toHaveClass('fleet-status-done')
    // Not `fleet-status-idle`: acknowledging a finish demotes it, but the work is still
    // yours to land, so it must not look like a workspace that never ran.
    const seen = screen.getByRole('button', { name: /Seen result/ })
    expect(seen).toHaveClass('fleet-status-done-seen')
    expect(seen).not.toHaveClass('fleet-status-idle')
    expect(seen).not.toHaveClass('fleet-status-done')
    expect(seen.querySelector('[data-agent-map-agent-status-glow]')).not.toBeInTheDocument()
  })

  it('hides the states the toolbar filter has muted', () => {
    const done = card({
      paneKey: 'done',
      conversationName: 'Done agent',
      unseen: true,
      bucket: 'done',
      dotState: 'done',
      finishedAt: NOW - 60_000
    })
    renderMap([card(), done], { enabledStates: new Set<AgentMapState>(['done']) })

    expect(screen.queryByRole('button', { name: /Agent alpha/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Done agent/ })).toBeInTheDocument()
  })

  it('preserves the viewport when filters temporarily empty the map', () => {
    const agent = card()
    const all = new Set<AgentMapState>(['attention', 'working', 'done', 'idle'])
    const view = renderMap([agent], { enabledStates: all })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const viewBox = view.container
      .querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
      .getAttribute('viewBox')

    const onOpenTerminal = vi.fn()
    view.rerender(
      <AgentMap
        cards={[agent]}
        now={NOW}
        onOpenTerminal={onOpenTerminal}
        enabledStates={new Set<AgentMapState>(['done'])}
      />
    )
    expect(view.container.querySelector('.agent-map-canvas > svg')).not.toBeInTheDocument()
    view.rerender(
      <AgentMap cards={[agent]} now={NOW} onOpenTerminal={onOpenTerminal} enabledStates={all} />
    )

    expect(view.container.querySelector('.agent-map-canvas > svg')).toHaveAttribute(
      'viewBox',
      viewBox
    )
  })

  it('preserves the viewport through an empty source snapshot', () => {
    const agent = card()
    const view = renderMap([agent])
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const viewBox = view.container
      .querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
      .getAttribute('viewBox')

    view.rerender(<AgentMap cards={[]} now={NOW} onOpenTerminal={vi.fn()} />)
    expect(view.container.querySelector('.agent-map-canvas > svg')).not.toBeInTheDocument()
    view.rerender(<AgentMap cards={[agent]} now={NOW} onOpenTerminal={vi.fn()} />)

    expect(view.container.querySelector('.agent-map-canvas > svg')).toHaveAttribute(
      'viewBox',
      viewBox
    )
  })

  it('aggregates only acknowledged idle results without repacking topology', () => {
    const results = Array.from({ length: 5 }, (_, index) =>
      card({
        paneKey: `done-${index}`,
        conversationName: `Result ${index}`,
        bucket: 'done',
        dotState: 'done',
        finishedAt: NOW - 60_000,
        unseen: true
      })
    )
    const view = renderMap(results)
    const { container } = view

    expect(container.querySelectorAll('[data-agent-map-agent]')).toHaveLength(5)
    expect(container.querySelectorAll('.agent-map-aggregate-node')).toHaveLength(0)
    view.rerender(
      <AgentMap
        cards={results.map((result) => ({ ...result, unseen: false }))}
        now={NOW}
        onOpenTerminal={vi.fn()}
      />
    )
    expect(container.querySelectorAll('[data-agent-map-agent]')).toHaveLength(0)
    expect(container.querySelectorAll('.agent-map-aggregate-node')).toHaveLength(1)

    view.rerender(
      <AgentMap
        cards={results.map((result) => ({ ...result, unseen: false }))}
        now={NOW}
        selectedPaneKey="done-0"
        onOpenTerminal={vi.fn()}
      />
    )
    expect(container.querySelectorAll('[data-agent-map-agent]')).toHaveLength(5)
    expect(container.querySelectorAll('.agent-map-aggregate-node')).toHaveLength(0)
  })
})
