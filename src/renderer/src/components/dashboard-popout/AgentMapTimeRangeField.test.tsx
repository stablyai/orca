// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type * as AgentMapLayoutModule from './agent-map-layout'
import type * as AgentMapProjectPlacementModule from './agent-map-project-placement'
import { AGENT_MAP_TIME_MAX_INDEX, type AgentMapTimeRange } from './agent-map-time-filter'

/** Counts the packing work one slider interaction costs. `repacks` only rises
 *  when `updateAgentMapLayout` misses its topology cache and runs the full
 *  `deriveAgentMapLayout` again; `updates` counts every layout evaluation. */
const layoutCalls = vi.hoisted(() => ({ updates: 0, repacks: 0 }))
const packCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('./agent-map-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentMapLayoutModule>()
  return {
    ...actual,
    updateAgentMapLayout: (
      ...args: Parameters<typeof actual.updateAgentMapLayout>
    ): ReturnType<typeof actual.updateAgentMapLayout> => {
      layoutCalls.updates += 1
      const result = actual.updateAgentMapLayout(...args)
      // A fresh cache object is returned only on the deriveAgentMapLayout path.
      if (result.cache !== args[0]) {
        layoutCalls.repacks += 1
      }
      return result
    }
  }
})

// Second, independent counter: the packer runs once per non-empty repack.
vi.mock('./agent-map-project-placement', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentMapProjectPlacementModule>()
  return {
    ...actual,
    placeAgentMapProjects: (
      ...args: Parameters<typeof actual.placeAgentMapProjects>
    ): ReturnType<typeof actual.placeAgentMapProjects> => {
      packCalls.count += 1
      return actual.placeAgentMapProjects(...args)
    }
  }
})

import { AgentDashboardMapView } from './AgentDashboardMapView'
import { AgentMapTimeRangeField } from './AgentMapTimeRangeField'

const NOW = 2_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const SLIDER_WIDTH = 280
/** Radix maps pointer x linearly onto [0, AGENT_MAP_TIME_MAX_INDEX]. */
const clientXForStop = (stop: number): number => (stop / AGENT_MAP_TIME_MAX_INDEX) * SLIDER_WIDTH

function card(overrides: Partial<DashboardCard> & { paneKey: string }): DashboardCard {
  return {
    ptyId: overrides.paneKey,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Pack the map',
    repoId: 'repo-1',
    worktreeId: `worktree-${overrides.paneKey}`,
    tabId: 'tab-1',
    leafId: `leaf-${overrides.paneKey}`,
    repoName: 'Orca',
    worktreeName: overrides.paneKey,
    startedAt: NOW - MINUTE,
    finishedAt: null,
    stateChangedAt: NOW - 1_000,
    statusUpdatedAt: NOW - 1_000,
    unseen: false,
    hostKind: 'local',
    workspaceKind: 'worktree',
    ...overrides
  }
}

/** One card per stop the drag crosses, each just old enough to be dropped by
 *  the next step down — so every value change is a real topology change. */
const LIFESPANS: readonly { paneKey: string; lifespan: number }[] = [
  { paneKey: 'agent-20d', lifespan: 20 * DAY },
  { paneKey: 'agent-10d', lifespan: 10 * DAY },
  { paneKey: 'agent-5d', lifespan: 5 * DAY },
  { paneKey: 'agent-2_5d', lifespan: 2.5 * DAY },
  { paneKey: 'agent-36h', lifespan: 36 * HOUR },
  { paneKey: 'agent-18h', lifespan: 18 * HOUR },
  { paneKey: 'agent-5m', lifespan: 5 * MINUTE }
]

const CARDS: DashboardCard[] = LIFESPANS.map(({ paneKey, lifespan }) =>
  card({ paneKey, startedAt: NOW - lifespan })
)

const SNAPSHOT: DashboardSnapshot = {
  generatedAt: NOW,
  cards: CARDS,
  workspaces: [],
  filterOptions: { projects: [], workspaceStatuses: [] }
}

/** Stops the max thumb passes through on one drag: ∞ → 12h. */
const DRAG_STOPS = [13, 12, 11, 10, 9, 8]
const EXPECTED_DRAG_REPACKS = 1
const DRAFT_CANCELLATIONS = [
  { name: 'pointer cancellation', finish: (thumb: HTMLElement) => fireEvent.pointerCancel(thumb) },
  {
    name: 'pointer capture loss',
    finish: (thumb: HTMLElement) => fireEvent.lostPointerCapture(thumb, { pointerId: 1 })
  },
  { name: 'focus loss', finish: (thumb: HTMLElement) => fireEvent.blur(thumb) },
  { name: 'Escape', finish: (thumb: HTMLElement) => fireEvent.keyDown(thumb, { key: 'Escape' }) }
]

function renderMapView(): ReturnType<typeof render> {
  return render(
    <AgentDashboardMapView
      snapshot={SNAPSHOT}
      cards={CARDS}
      query=""
      onQueryChange={vi.fn()}
      filters={{ projects: [], workspaceStatuses: [], reviewStates: [] }}
      onFiltersChange={vi.fn()}
      searchInputRef={{ current: null }}
      now={NOW}
      dialogCard={null}
      onDialogOpenChange={vi.fn()}
      onRevealAgent={vi.fn()}
      onOpenTerminal={vi.fn()}
      workspaceContextMenusEnabled={false}
    />
  )
}

async function openTimeSection(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }))
  fireEvent.click(await screen.findByRole('button', { name: /^Time/ }))
  const slider = await screen.findByRole('slider', { name: 'Session lifespan maximum' })
  return slider
}

/** Mirrors the panel's wiring: the field is controlled and the owner re-renders
 *  on every published range. */
function ControlledField({
  label,
  initial,
  onChange
}: {
  label: string
  initial: AgentMapTimeRange
  onChange: (range: AgentMapTimeRange) => void
}): React.JSX.Element {
  const [range, setRange] = useState(initial)
  return (
    <AgentMapTimeRangeField
      label={label}
      range={range}
      onChange={(next) => {
        setRange(next)
        onChange(next)
      }}
    />
  )
}

/** Radix reads geometry off the root and gates moves on pointer capture. */
function stubSliderGeometry(): () => void {
  const captured = new Set<number>()
  const element = Element.prototype as unknown as {
    setPointerCapture: (id: number) => void
    hasPointerCapture: (id: number) => boolean
    releasePointerCapture: (id: number) => void
  }
  const original = {
    setPointerCapture: element.setPointerCapture,
    hasPointerCapture: element.hasPointerCapture,
    releasePointerCapture: element.releasePointerCapture
  }
  element.setPointerCapture = (id) => void captured.add(id)
  element.hasPointerCapture = (id) => captured.has(id)
  element.releasePointerCapture = (id) => void captured.delete(id)
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: SLIDER_WIDTH,
    bottom: 24,
    width: SLIDER_WIDTH,
    height: 24,
    toJSON: () => ({})
  })
  return () => {
    element.setPointerCapture = original.setPointerCapture
    element.hasPointerCapture = original.hasPointerCapture
    element.releasePointerCapture = original.releasePointerCapture
    rect.mockRestore()
  }
}

function dragThumb(thumb: HTMLElement, stops: readonly number[], onStep?: () => void): void {
  act(() => {
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: SLIDER_WIDTH })
  })
  for (const stop of stops) {
    act(() => {
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: clientXForStop(stop) })
    })
    onStep?.()
  }
  act(() => {
    fireEvent.pointerUp(thumb, { pointerId: 1, clientX: clientXForStop(stops.at(-1) ?? 0) })
  })
}

describe('AgentMapTimeRangeField', () => {
  let restoreGeometry: () => void

  beforeEach(() => {
    layoutCalls.updates = 0
    layoutCalls.repacks = 0
    packCalls.count = 0
    restoreGeometry = stubSliderGeometry()
  })

  afterEach(() => {
    restoreGeometry()
    cleanup()
    vi.restoreAllMocks()
  })

  it('repacks the whole map once when a multi-stop drag commits', async () => {
    renderMapView()
    await waitFor(() => expect(document.querySelector('.agent-map-canvas')).toBeTruthy())
    const mountRepacks = layoutCalls.repacks
    const mountUpdates = layoutCalls.updates
    const mountPacks = packCalls.count

    const thumb = await openTimeSection()
    dragThumb(thumb, DRAG_STOPS)

    expect(layoutCalls.repacks - mountRepacks).toBe(EXPECTED_DRAG_REPACKS)
    expect(packCalls.count - mountPacks).toBe(EXPECTED_DRAG_REPACKS)
    expect(layoutCalls.updates - mountUpdates).toBe(EXPECTED_DRAG_REPACKS)
    expect(screen.getByText('of 7 agents shown').parentElement).toHaveTextContent(
      '1 of 7 agents shown'
    )
    await waitFor(() => expect(document.querySelectorAll('[data-agent-map-agent]')).toHaveLength(1))
  })

  it('updates the thumb and readout at every intermediate drag stop', async () => {
    renderMapView()
    await waitFor(() => expect(document.querySelector('.agent-map-canvas')).toBeTruthy())
    const thumb = await openTimeSection()
    const field = thumb.closest('[data-slot="slider"]')?.parentElement as HTMLElement
    const readouts: string[] = []
    const thumbValues: string[] = []

    dragThumb(thumb, DRAG_STOPS, () => {
      readouts.push(within(field).getByText(/–|any/).textContent ?? '')
      thumbValues.push(thumb.getAttribute('aria-valuenow') ?? '')
    })

    expect(readouts).toEqual(['0 – 14d', '0 – 7d', '0 – 3d', '0 – 2d', '0 – 1d', '0 – 12h'])
    expect(thumbValues).toEqual(DRAG_STOPS.map(String))
  })

  it('keeps the readout, chip, and map aligned after a full-range collapse', async () => {
    renderMapView()
    await waitFor(() => expect(document.querySelector('.agent-map-canvas')).toBeTruthy())

    const thumb = await openTimeSection()
    dragThumb(thumb, [0])

    expect(screen.getByText('0 – 0')).toBeInTheDocument()
    expect(screen.getByText('Session lifespan: 0–0')).toBeInTheDocument()
    expect(screen.getByText('of 7 agents shown').parentElement).toHaveTextContent(
      '0 of 7 agents shown'
    )
    await waitFor(() => expect(document.querySelectorAll('[data-agent-map-agent]')).toHaveLength(0))
  })

  it('publishes only the final range for a multi-stop drag', () => {
    const onChange = vi.fn()
    render(
      <ControlledField
        label="Session lifespan"
        initial={{ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }}
        onChange={onChange}
      />
    )

    dragThumb(screen.getByRole('slider', { name: 'Session lifespan maximum' }), DRAG_STOPS)

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ min: 0, max: DRAG_STOPS.at(-1) })
  })

  it.each([
    { name: 'a narrowed range', initial: { min: 5, max: AGENT_MAP_TIME_MAX_INDEX }, stop: 5 },
    { name: 'the full range', initial: { min: 0, max: AGENT_MAP_TIME_MAX_INDEX }, stop: 0 }
  ])('commits max-thumb collapse from $name', ({ initial, stop }) => {
    const onChange = vi.fn()
    render(<ControlledField label="Session lifespan" initial={initial} onChange={onChange} />)

    dragThumb(screen.getByRole('slider', { name: 'Session lifespan maximum' }), [stop])

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ min: stop, max: stop })
    expect(
      screen.getByText(`${stop === 0 ? '0' : '1h'} – ${stop === 0 ? '0' : '1h'}`)
    ).toBeInTheDocument()
  })

  it('follows an external range change while a draft is active', () => {
    const onChange = vi.fn()
    const field = (range: AgentMapTimeRange): React.JSX.Element => (
      <AgentMapTimeRangeField label="Session lifespan" range={range} onChange={onChange} />
    )
    const view = render(field({ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }))
    expect(screen.getByText('any')).toBeInTheDocument()

    view.rerender(field({ min: 4, max: 9 }))

    expect(screen.getByText('30m – 1d')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Session lifespan minimum' })).toHaveAttribute(
      'aria-valuenow',
      '4'
    )
    expect(screen.getByRole('slider', { name: 'Session lifespan maximum' })).toHaveAttribute(
      'aria-valuenow',
      '9'
    )

    const thumb = screen.getByRole('slider', { name: 'Session lifespan maximum' })
    act(() => {
      fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: clientXForStop(9) })
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: clientXForStop(7) })
    })
    expect(screen.getByText('30m – 6h')).toBeInTheDocument()

    view.rerender(field({ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }))

    expect(screen.getByText('any')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Session lifespan maximum' })).toHaveAttribute(
      'aria-valuenow',
      String(AGENT_MAP_TIME_MAX_INDEX)
    )
  })

  it('does not commit an interaction invalidated by an external range change', () => {
    const onChange = vi.fn()
    const field = (range: AgentMapTimeRange): React.JSX.Element => (
      <AgentMapTimeRangeField label="Session lifespan" range={range} onChange={onChange} />
    )
    const view = render(field({ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }))
    const thumb = screen.getByRole('slider', { name: 'Session lifespan maximum' })

    act(() => {
      fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: SLIDER_WIDTH })
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: clientXForStop(8) })
    })
    view.rerender(field({ min: 4, max: 9 }))
    act(() => {
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: clientXForStop(7) })
      fireEvent.pointerUp(thumb, { pointerId: 1, clientX: clientXForStop(7) })
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it.each(DRAFT_CANCELLATIONS)('discards a pointer draft on $name', ({ finish }) => {
    const onChange = vi.fn()
    render(
      <AgentMapTimeRangeField
        label="Session lifespan"
        range={{ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }}
        onChange={onChange}
      />
    )
    const thumb = screen.getByRole('slider', { name: 'Session lifespan maximum' })

    act(() => {
      fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: SLIDER_WIDTH })
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: clientXForStop(8) })
    })
    expect(screen.getByText('0 – 12h')).toBeInTheDocument()
    finish(thumb)

    expect(screen.getByText('any')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits a keyboard arrow step', () => {
    const onChange = vi.fn()
    render(
      <AgentMapTimeRangeField
        label="Session lifespan"
        range={{ min: 0, max: AGENT_MAP_TIME_MAX_INDEX }}
        onChange={onChange}
      />
    )

    const thumb = screen.getByRole('slider', { name: 'Session lifespan maximum' })
    // Radix routes arrow keys to the last focused thumb, not the event target.
    act(() => thumb.focus())
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' })

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ min: 0, max: AGENT_MAP_TIME_MAX_INDEX - 1 })
  })
})
