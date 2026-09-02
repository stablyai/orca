// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

const ringRender = vi.hoisted(() => vi.fn())
vi.mock('./AgentMapWorktreeRingNode', () => ({
  AgentMapWorktreeRingNode: ({ worktree }: { worktree: { id: string } }) => {
    ringRender(worktree.id)
    return <circle data-testid="instrumented-worktree" />
  }
}))

import { AgentMap } from './AgentMap'

const NOW = 2_000_000_000
const CARD: DashboardCard = {
  paneKey: 'pane-1',
  ptyId: 'pty-1',
  agentType: 'codex',
  bucket: 'working',
  dotState: 'working',
  task: 'Measure map',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  repoName: 'Orca',
  worktreeName: 'Performance',
  startedAt: NOW - 1_000,
  finishedAt: null,
  stateChangedAt: NOW - 1_000,
  unseen: false
}

describe('AgentMapCanvas pointer performance', () => {
  const frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames.length = 0
    ringRender.mockClear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 560,
      width: 800,
      height: 560,
      toJSON: () => ({})
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('presents the map as a non-selectable panning surface', () => {
    const { container } = render(<AgentMap cards={[CARD]} now={NOW} onOpenTerminal={vi.fn()} />)
    const svg = container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!

    expect(svg).toHaveClass('cursor-grab', 'touch-none', 'select-none', 'active:cursor-grabbing')
  })

  it('coalesces drag frames without rerendering worktree nodes', () => {
    const { container } = render(<AgentMap cards={[CARD]} now={NOW} onOpenTerminal={vi.fn()} />)
    const svg = container.querySelector<SVGSVGElement>('.agent-map-canvas > svg')!
    Object.assign(svg, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    })
    expect(ringRender).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(svg, { pointerId: 2, button: 2, clientX: 20, clientY: 20 })
    expect(svg.setPointerCapture).not.toHaveBeenCalled()

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 20 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 60, clientY: 20 })
    expect(frames).toHaveLength(1)

    act(() => frames.shift()?.(0))
    expect(ringRender).toHaveBeenCalledTimes(1)
  })
})
